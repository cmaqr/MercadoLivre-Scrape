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
            console.log('JSON-LD não encontrado na página. Extraindo dados do DOM...');
          }

    // Extrai itens do JSON-LD ou do DOM
    let itemsFromJsonLd = [];
    
    if (jsonLdProducts.length > 0) {
      itemsFromJsonLd = jsonLdProducts.map(p => ({
        name: p.name || null,
        url: p.url || (p.offers && p.offers.url) || (p['@id'] || null),
        price: (p.offers && p.offers.price) || null,
        image: Array.isArray(p.image) ? p.image[0] : p.image || null
      }));
    } else {
      // Se não tem JSON-LD, extrai do JavaScript/JSON embutido na página
      itemsFromJsonLd = await page.evaluate(() => {
        const items = [];
        
        // Procura por dados JSON embutidos no HTML (NextJS/React data)
        const scripts = Array.from(document.querySelectorAll('script'));
        let polycardsData = [];
        
        for (const script of scripts) {
          if (!script.textContent) continue;
          try {
            const match = script.textContent.match(/"results":\s*\[(.*?)\]/);
            if (match) {
              // Tenta fazer parse da seção de results
              const resultsStr = '[' + match[1] + ']';
              const results = JSON.parse(resultsStr);
              polycardsData = results.filter(r => r.polycard && r.polycard.primary_title);
              if (polycardsData.length > 0) break;
            }
          } catch (e) {
            // continua procurando
          }
        }
        
        // Se conseguiu extrair do JSON, processa os dados
        // Mas APENAS se a URL estiver válida (contenha mercadolivre.com.br e um ID)
        if (polycardsData.length > 0) {
          const validItems = [];
          polycardsData.forEach((item, idx) => {
            try {
              const pc = item.polycard;
              
              const name = pc.primary_title || `Produto ${idx + 1}`;
              const rawUrl = (pc.metadata && pc.metadata.url) ? 'https://' + pc.metadata.url : null;
              
              // Valida se a URL contém um ID válido (MLB/MLA/MLU + números)
              const hasValidId = rawUrl && /(MLB|MLA|MLU)[-]?\d+/i.test(rawUrl);
              if (!rawUrl || !hasValidId) {
                // URL inválida, pula este item para extrair do DOM
                return;
              }
              
              const url = rawUrl;
              
              // Procura pela imagem
              let image = null;
              if (pc.pictures && pc.pictures.pictures && pc.pictures.pictures[0]) {
                const picId = pc.pictures.pictures[0].id;
                image = `https://http2.mlstatic.com/${picId}.webp`;
              }
              
              // Extrai preço
              let price = null;
              if (pc.prices && pc.prices.primary_price) {
                price = parseFloat(pc.prices.primary_price.amount) || null;
              }
              
              // Extrai brand
              let brand = null;
              
              // Tenta extrair dos atributos (se disponível)
              if (pc.attributes && Array.isArray(pc.attributes)) {
                const brandAttr = pc.attributes.find(a => a.id === 'BRAND' || a.name === 'Marca');
                if (brandAttr) {
                  brand = brandAttr.value || brandAttr.text;
                }
              }
              
              // Se não achou, tenta do highlight (ex: "Por Apple")
              if (!brand && pc.highlight && pc.highlight.text) {
                 const hText = pc.highlight.text;
                 if (hText.toLowerCase().startsWith('por ') || hText.toLowerCase().startsWith('by ')) {
                    brand = hText.substring(4).trim();
                 }
              }
              
              // Extrai rating
              let rating = null;
              if (pc.reviews && pc.reviews.rating) {
                rating = parseFloat(pc.reviews.rating) || null;
              }
              
              // Extrai ratingCount
              let ratingCount = null;
              if (pc.reviews && pc.reviews.review_count) {
                ratingCount = parseInt(pc.reviews.review_count) || null;
              }
              
              validItems.push({
                name: name,
                url: url,
                price: price,
                image: image,
                brand: brand,
                rating: rating,
                ratingCount: ratingCount
              });
            } catch (e) {
              // continua com próximo item
            }
          });
          
          // Se conseguiu extrair items válidos do JSON, retorna apenas eles
          if (validItems.length > 0) {
            return validItems;
          }
        }
        
        return items;
      });
      
      // Se ainda não conseguiu extrair nada, volta ao método de DOM
      if (itemsFromJsonLd.length === 0) {
        itemsFromJsonLd = await page.evaluate(() => {
          // Função para normalizar URL para o padrão limpo
          const normalizeUrl = (href) => {
            if (!href) return null;
            
            // Remove query params e hash
            let cleanUrl = href.split('?')[0].split('#')[0];
            
            // Se é URL de tracking (click1.mercadolivre), extrai o ID e reconstrói
            const trackingMatch = cleanUrl.match(/(MLB|MLA|MLU)[-]?(\d+)/i);
            if (trackingMatch) {
              const productId = trackingMatch[0].replace('-', '');
              
              // Tenta extrair o slug do URL original ou reconstruir
              const titleMatch = href.match(/\/([a-z0-9-]+)\/p\/(MLB|MLA|MLU)[-]?\d+/i);
              if (titleMatch) {
                const slug = titleMatch[1];
                return `https://www.mercadolivre.com.br/${slug}/p/${productId}`;
              }
              
              // Se não conseguir slug, usa apenas o ID (será expandido depois)
              return `https://www.mercadolivre.com.br/p/${productId}`;
            }
            
            // Se já é URL limpa de www.mercadolivre.com.br, apenas limpa
            if (cleanUrl.includes('www.mercadolivre.com.br')) {
              // Remove tudo após /p/[ID]
              const idMatch = cleanUrl.match(/\/p\/(MLB|MLA|MLU)[-]?\d+/i);
              if (idMatch) {
                const endIdx = cleanUrl.indexOf(idMatch[0]) + idMatch[0].length;
                return cleanUrl.substring(0, endIdx);
              }
              return cleanUrl;
            }
            
            return cleanUrl;
          };
          
          const items = [];
          const cards = document.querySelectorAll('[data-component-type="s-search-result"], .ui-search-layout__item');
          
          cards.forEach((card, idx) => {
            try {
              let linkEl = card.querySelector('a[href*="MLB"], a[href*="MLA"], a[href*="MLU"]');
              if (!linkEl) linkEl = card.querySelector('h2 a') || card.querySelector('a[href*="mercadolivre"]');
              if (!linkEl) return;
              
              const url = normalizeUrl(linkEl.href);
              // Garante que a URL tenha o padrão de ID exigido (MLB, MLA, MLU)
              if (!url || !/(MLB|MLA|MLU)[-]?\d+/i.test(url)) return;

              const imgEl = card.querySelector('img[src*="mlstatic"]');
              const image = imgEl ? (imgEl.dataset.src || imgEl.src) : null;
              
              let name = linkEl.getAttribute('title') || linkEl.innerText || '';
              name = name.trim().split('\n')[0] || `Produto ${idx + 1}`;
              
              // Extrai brand: procura em vários lugares possíveis
              let brand = null;
              
              // Primeiro tenta: .poly-component__highlight (LOJA OFICIAL, MARCA, etc)
              const highlightEl = card.querySelector('.poly-component__highlight');
              if (highlightEl) {
                const highlightText = highlightEl.innerText.trim();
                if (highlightText && highlightText.length < 50) {
                  const lower = highlightText.toLowerCase();
                  if (lower.startsWith('por ') || lower.startsWith('by ')) {
                    brand = highlightText.substring(4).trim();
                  } else if (!lower.includes('vendidos') && !lower.includes('%') && !lower.includes('oferta') && !lower.includes('patrocinado') && !lower.includes('disponível') && !lower.includes('off')) {
                    brand = highlightText;
                  }
                }
              }
              
              // Se não achou, tenta: classe específica de brand
              if (!brand) {
                const brandEl = card.querySelector('.poly-component__brand');
                if (brandEl) {
                  brand = brandEl.innerText.trim();
                }
              }
              
              // Extrai rating e ratingCount dos elementos poly-phrase-label
              let rating = null;
              let ratingCount = null;
              
              const phraseLabels = card.querySelectorAll('.poly-phrase-label');
              for (const label of phraseLabels) {
                const text = label.innerText.trim();
                
                // Procura por rating: "4.9", "4.5", etc
                const ratingMatch = text.match(/^([0-9]+(?:[.,][0-9]+)?)$/);
                if (ratingMatch && !rating) {
                  rating = parseFloat(ratingMatch[1].replace(',', '.'));
                  continue;
                }
                
                // Procura por ratingCount: "+5mil vendidos", "+50k vendidos", "+1.2k vendidos", etc
                const countMatch = text.match(/\+\s*([0-9.]+)\s*(mil|k)\s+vendidos?/i);
                if (countMatch && !ratingCount) {
                  const numberPart = parseFloat(countMatch[1].replace(',', '.'));
                  const unit = countMatch[2].toLowerCase();
                  
                  // Converte para número inteiro
                  if (unit === 'mil' || unit === 'k') {
                    ratingCount = Math.round(numberPart * 1000);
                  }
                }
              }
              
              items.push({
                name: name,
                url: url,
                price: null,
                image: image,
                brand: brand,
                rating: rating,
                ratingCount: ratingCount
              });
            } catch (e) { }
          });
          
          return items;
        });
      }
      
      console.log(`Extraídos ${itemsFromJsonLd.length} produtos do JSON/DOM`);
    }

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
        const idMatch = url.match(/(MLB|MLA|MLU)[-]?\d+/i);
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

          // Preenche dados do DOM se disponíveis
          if ('brand' in result) result.brand = item.brand || null;
          if ('rating' in result) result.rating = item.rating || null;
          if ('ratingCount' in result) result.ratingCount = item.ratingCount || null;

          if ('id' in result) {
            // Extrai ID no padrão (MLB|MLA|MLU) + números (ex: MLB1027172671)
            const idMatch = item.url.match(/(MLB|MLA|MLU)[-]?\d+/i);
            if (idMatch && idMatch[0]) {
              result.id = idMatch[0].toUpperCase().replace('-', '');
            } else {
              result.id = null;
            }
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
            
            // Detecta isFull: procura por aria-label="full" ou classe vpp_full
            if ('isFull' in result && (nodeHtml.includes('aria-label="full"') || nodeHtml.includes('FULL') || nodeHtml.includes('vpp_full') || nodeText.includes('enviado pelo') || nodeText.includes('full'))) {
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

        // Sempre adiciona name internamente para ser usado como chave, mesmo se não estiver em fieldMap
        result._internalName = itemName;
        return result;
      });
    }, itemsFromJsonLd, fieldMap);

    // Filtra apenas itens com ID válido (contendo MLB, MLA ou MLU)
    const validEnriched = enriched.filter(it => it.id && /(MLB|MLA|MLU)/i.test(it.id));

    // Mesclar dados do JSON-LD (jsonLdProducts) com os itens enriquecidos pelo DOM.
    // Alguns sites colocam o preço atual no JSON-LD e o preço anterior (riscado) apenas no DOM.
    const productsMap = {};
    validEnriched.forEach(it => { 
      const key = it._internalName || it.id || 'produto_sem_nome';
      delete it._internalName; // Remove o campo interno antes de salvar
      productsMap[key] = it; 
    });

    // Criar índice rápido dos JSON-LD por id/url para mesclagem
    const jsonLdIndex = {};
    for (const p of jsonLdProducts) {
      try {
        const url = (p.url || (p.offers && p.offers.url) || p['@id'] || '').toString();
        const idMatch = url.match(/(MLB|MLA|MLU)[-]?\d+/i);
        const id = idMatch ? idMatch[0].replace('-', '') : (url.split('/').filter(Boolean).pop() || null);
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
      count: validEnriched.length,
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