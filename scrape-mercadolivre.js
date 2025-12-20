import 'dotenv/config';
import puppeteer from 'puppeteer';
import { writeFile } from 'fs/promises';

function montarUrl(term) {
  return 'https://lista.mercadolivre.com.br/' + term.trim().replace(/\s+/g, '-') + '#D[A:' + term.trim().replace(/\s+/g, '-') + ']';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start(term) {
  const url = montarUrl(term);
  const termSlug = term.trim().replace(/\s+/g, '-');

  // --- CONFIGURAÇÃO DE PROXY ---
  // Preencha aqui se precisar usar proxy. Ex: 'http://123.123.123.123:8080'
  const proxyServer = process.env.PROXY_SERVER || ''; 
  const proxyUsername = process.env.PROXY_USERNAME || '';
  const proxyPassword = process.env.PROXY_PASSWORD || '';
  // -----------------------------

  let browser;
  try {
    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
    if (proxyServer) launchArgs.push(`--proxy-server=${proxyServer}`);

    browser = await puppeteer.launch({ headless: false, slowMo: 50, args: launchArgs });
    const page = await browser.newPage();

    if (proxyServer && proxyUsername) {
      await page.authenticate({ username: proxyUsername, password: proxyPassword });
    }

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // fecha o browser ao Ctrl+C
    process.on('SIGINT', async () => {
      try { if (browser) await browser.close(); } catch (e) { }
      process.exit();
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('.ui-search-result, .ui-search-layout', { timeout: 30000 });

    // rolagem até o fim da página: executa scroll e compara altura do body
    // quando a altura parar de aumentar (duas checagens consecutivas), assume que chegou ao fim
    let previousHeight = await page.evaluate(() => document.body.scrollHeight);
    let sameCount = 0;
    const maxTries = 60;
    for (let i = 0; i < maxTries; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await delay(1200);
      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (newHeight === previousHeight) {
        sameCount++;
        if (sameCount >= 2) {
          // nenhuma mudança após duas checagens: fim da página
          break;
        }
      } else {
        previousHeight = newHeight;
        sameCount = 0;
      }
    }

    const jsonLdText = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const s of scripts) {
        if (!s.textContent) continue;
        try {
          const parsed = JSON.parse(s.textContent);
          if (parsed['@type'] === 'Product') return s.textContent;
          if (parsed['@graph'] && parsed['@graph'].some(g => g['@type'] === 'Product')) return s.textContent;
        } catch (e) { }
      }
      return null;
    });

    let jsonLdProducts = [];
    if (jsonLdText) {
      try {
        const parsed = JSON.parse(jsonLdText);
        const graph = parsed['@graph'] || (parsed['@type'] === 'Product' ? [parsed] : []);
        jsonLdProducts = Array.isArray(graph) ? graph.filter(p => p && p['@type'] === 'Product') : [];
            } catch (e) {
        console.error('Erro ao parsear JSON-LD:', e.message);
            }
          } else {
            console.log('JSON-LD não encontrado na página.');
          }

          const itemsFromJsonLd = jsonLdProducts.map(p => ({
            name: p.name || null,
            url: p.url || (p.offers && p.offers.url) || (p['@id'] || null),
            price: (p.offers && p.offers.price) || null,
            image: Array.isArray(p.image) ? p.image[0] : p.image || null
          }));

    // ========== MAPA DE CAMPOS: EDITE AQUI PARA INCLUIR/EXCLUIR CAMPOS ==========
    // Descomente/comente campos conforme necessário. Use o formato: nomeDoCampo: tipo
    const fieldMap = {
      // Identificação e URL
      id: 'string',
      //name: 'string',
      url: 'string',
      image: 'string',
      
      // Preços
      price: 'number',
      promoPrice: 'number',
      //priceText: 'string',
      //promoPriceText: 'string',
      //priceFromJsonLd: 'number',
      //offerPrice: 'number',
      
      // Flags de entrega e fulfillment
      isFull: 'boolean',
      freeShipping: 'boolean',
      comesTomorrow: 'boolean',
      
      // Dados do JSON-LD
      brand: 'string',
      rating: 'number',
      ratingCount: 'number',
      //offerAvailability: 'string',
      
      // Debug
      //rawNodeText: 'string',
    };
    // ============================================================================

    const enriched = await page.evaluate((items, fields) => {
      const clean = s => (s || '').replace(/\?.*$/, '').replace(/\/$/, '');
      const parsePrice = txt => {
        if (!txt) return null;
        let t = String(txt).replace(/\s+/g, ' ');
        t = t.replace(/R\$|\$/gi, '').trim();
        t = t.replace(/\.(?=\d{3})/g, '');
        t = t.replace(/,/g, '.');
        const n = parseFloat(t.replace(/[^0-9.-]/g, ''));
        return Number.isFinite(n) ? n : null;
      };

      const findAnchor = url => {
        if (!url) return null;
        const cleaned = clean(url);
        const idMatch = url.match(/(MLB|MLA|MLU)\d+/i);
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        for (const a of anchors) {
          try {
            const href = clean(a.href);
            if (href === cleaned) return a;
            if (idMatch && href.includes(idMatch[0])) return a;
            const p1 = href.split('/').filter(Boolean).pop();
            const p2 = cleaned.split('/').filter(Boolean).pop();
            if (p1 && p2 && p1 === p2) return a;
          } catch (e) { }
        }
        return null;
      };

      // Cria objeto result com apenas os campos definidos no fieldMap
      const createResult = () => {
        const obj = {};
        for (const key of Object.keys(fields)) {
          obj[key] = fields[key] === 'boolean' ? false : null;
        }
        return obj;
      };

      return items.map((item, idx) => {
        const result = createResult();
        // Armazena o name antes do try para usar depois
        let itemName = item.name || null;

        try {
          // Preenche campos iniciais do item
          if ('name' in result) result.name = itemName;
          if ('url' in result) result.url = item.url || null;
          if ('price' in result) result.price = item.price || null;
          if ('image' in result) result.image = item.image || null;

          if ('id' in result) {
            const m = item.url.match(/(MLB|MLA|MLU)\d+/i);
            result.id = m ? m[0] : (item.url.split('/').filter(Boolean).pop() || null);
          }

          const a = findAnchor(item.url);
          const node = a ? (a.closest('.ui-search-result, .ui-search-layout__item, li, .andes-card') || a.parentElement) : null;

          if (node) {
            if ('rawNodeText' in result) {
              result.rawNodeText = (node.innerText || '').slice(0, 2000);
            }
            
            // Extrai frete grátis, isFull e entrega rápida do texto do node
            const nodeText = (node.innerText || '').toLowerCase();
            const nodeHtml = node.outerHTML || '';
            
            // Detecta freeShipping: procura por "frete grátis" ou "frete gratis"
            if ('freeShipping' in result && (nodeText.includes('frete grátis') || nodeText.includes('frete gratis'))) {
              result.freeShipping = true;
            }
            
            // Detecta isFull: procura por "FULL", "full", "enviado pelo", ou qualquer variação
            if ('isFull' in result && (nodeHtml.includes('FULL') || nodeHtml.includes('vpp_full') || nodeText.includes('enviado pelo') || nodeText.includes('full'))) {
              result.isFull = true;
            }
            
            // Detecta comesTomorrow: procura por "amanhã", "amanha", "chegará", "chegara", "rápido amanhã", etc
            if ('comesTomorrow' in result && (nodeText.includes('amanhã') || nodeText.includes('amanha') || nodeText.includes('chegará') || nodeText.includes('chegara') || nodeText.includes('chega amanhã') || nodeText.includes('chega amanha') || nodeText.includes('rápido amanhã') || nodeText.includes('rapido amanha'))) {
              result.comesTomorrow = true;
            }

            // Extrai preço riscado (antes) e preço atual (desconto)
            // Estrutura: <s class="andes-money-amount--previous"> = ANTES
            //            <span class="poly-price__current"> contém o AGORA
            const riscadoEl = node.querySelector('s.andes-money-amount--previous');
            const descuentoContainer = node.querySelector('.poly-price__current');

            // Se tem preço riscado: price = riscado, promoPrice = descuento
            // Se não tem preço riscado: price = descuento (o preço original)
            if (riscadoEl) {
              const frac = riscadoEl.querySelector('.andes-money-amount__fraction');
              const cents = riscadoEl.querySelector('.andes-money-amount__cents');
              const riscadoText = ((frac?.innerText || '') + (cents ? ',' + cents.innerText : '')).trim();
              if ('price' in result) {
                result.price = parsePrice(riscadoText);
              }
              if ('priceText' in result) {
                result.priceText = riscadoText;
              }
            }

            if (descuentoContainer) {
              const spanEl = descuentoContainer.querySelector('.andes-money-amount');
              if (spanEl) {
                const frac = spanEl.querySelector('.andes-money-amount__fraction');
                const cents = spanEl.querySelector('.andes-money-amount__cents');
                const descuentoText = ((frac?.innerText || '') + (cents ? ',' + cents.innerText : '')).trim();
                const descuentoValue = parsePrice(descuentoText);
                
                if (!riscadoEl) {
                  // Sem preço riscado: price recebe o valor atual
                  if ('price' in result) {
                    result.price = descuentoValue;
                  }
                  if ('priceText' in result) {
                    result.priceText = descuentoText;
                  }
                } else {
                  // Com preço riscado: promoPrice recebe o valor de descuento
                  if ('promoPrice' in result) {
                    result.promoPrice = descuentoValue;
                  }
                  if ('promoPriceText' in result) {
                    result.promoPriceText = descuentoText;
                  }
                }
              }
            }

            const img = node.querySelector('img');
            if (img && 'image' in result) result.image = img.dataset.src || img.src || result.image;
          }
        } catch (e) { }

        if ('id' in result && !result.id) result.id = `item_${idx+1}`;
        // Sempre adiciona name internamente para ser usado como chave, mesmo se não estiver em fieldMap
        result._internalName = itemName;
        return result;
      });
    }, itemsFromJsonLd, fieldMap);

    // Mesclar dados do JSON-LD (jsonLdProducts) com os itens enriquecidos pelo DOM.
    // Alguns sites colocam o preço atual no JSON-LD e o preço anterior (riscado) apenas no DOM.
    const productsMap = {};
    enriched.forEach(it => { 
      const key = it._internalName || it.id || 'produto_sem_nome';
      delete it._internalName; // Remove o campo interno antes de salvar
      productsMap[key] = it; 
    });

    // Criar índice rápido dos JSON-LD por id/url para mesclagem
    const jsonLdIndex = {};
    for (const p of jsonLdProducts) {
      try {
        const url = (p.url || (p.offers && p.offers.url) || p['@id'] || '').toString();
        const idMatch = url.match(/(MLB|MLA|MLU)\d+/i);
        const id = idMatch ? idMatch[0] : (url.split('/').filter(Boolean).pop() || null);
        if (id) jsonLdIndex[id] = p;
        if (url) jsonLdIndex[url] = p; // também indexar por URL
      } catch (e) { }
    }

    // Mesclar: para cada produto enriquecido, puxa dados do JSON-LD quando faltante
    Object.keys(productsMap).forEach(k => {
      const prod = productsMap[k];
      // tenta achar JSON-LD por id primeiro, depois por url
      let ld = jsonLdIndex[prod.id] || (prod.url ? jsonLdIndex[prod.url] : null);
      
      // Se não encontrou por ID, tenta por nome
      if (!ld && prod.name) {
        ld = Object.values(jsonLdProducts).find(p => p.name === prod.name);
      }
      
      if (ld) {
        // Extrai dados diretos do jsonLd
        if ('brand' in prod) prod.brand = ld.brand?.name || null;
        if ('rating' in prod) prod.rating = ld.aggregateRating?.ratingValue || null;
        if ('ratingCount' in prod) prod.ratingCount = ld.aggregateRating?.ratingCount || null;
        
        // Extrai dados do offers
        if (ld.offers) {
          if ('offerPrice' in prod) prod.offerPrice = ld.offers.price || null;
          if ('offerAvailability' in prod) prod.offerAvailability = ld.offers.availability || null;
        }
        
        const ldPrice = (ld.offers && ld.offers.price) || ld.price || null;
        if ('price' in prod && (prod.price === null || prod.price === undefined) && ldPrice != null) {
          prod.price = ldPrice;
        } else if ('priceFromJsonLd' in prod && ldPrice != null) {
          prod.priceFromJsonLd = ldPrice;
        }
      }
    });
//html debug
    const html = await page.content();
    const htmlFile = `debug-${termSlug}-${Date.now()}.html`;
    await writeFile(htmlFile, html, 'utf8');
    console.log('HTML salvo em:', htmlFile);

    const out = {
      term,
      url,
      scrapedAt: new Date().toISOString(),
      count: enriched.length,
      products: productsMap,
     // itemsArray: enriched,
     // jsonLdCount: jsonLdProducts.length,
     // jsonLdProducts
    };

    const outFile = `scraped-${termSlug}-${Date.now()}.json`;
    await writeFile(outFile, JSON.stringify(out, null, 2), 'utf8');
    console.log('Dados consolidados salvos em:', outFile);

    await browser.close();
  } catch (err) {
    console.error('Erro durante scraping:', err && err.message ? err.message : err);
    try { if (browser) await browser.close(); } catch (e) { }
    process.exit(1);
  }
}

const term = process.argv.slice(2).join(' ');

if (!term) {
  console.error('Por favor, informe o termo de busca. Ex: node scrape-mercadolivre.js "iphone 15"');
  process.exit(1);
}

start(term);