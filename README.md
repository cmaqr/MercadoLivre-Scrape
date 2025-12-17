# Mercado Livre Scraper

Este projeto é um script de automação em Node.js que utiliza o [Puppeteer](https://pptr.dev/) para realizar scraping de dados de produtos no Mercado Livre com base em um termo de pesquisa fornecido via linha de comando.

## Funcionalidades

- **Busca Dinâmica**: Aceita qualquer termo de pesquisa via CLI.
- **Rolagem Automática**: Executa scroll na página para carregar produtos via "infinite scroll".
- **Extração Híbrida**: Coleta dados tanto dos elementos visuais (DOM) quanto de dados estruturados ocultos (JSON-LD).
- **Dados Coletados**: Título, preço, preço promocional, imagem, link, frete grátis, entrega Full, entre outros.
- **Debug**: Salva uma cópia do HTML da página para análise em caso de erros.

## Pré-requisitos

- [Node.js](https://nodejs.org/) (versão 14 ou superior recomendada).

## Instalação

1. Abra o terminal na pasta do projeto.
2. Instale as dependências necessárias (principalmente o Puppeteer):

```bash
npm install puppeteer
```

## Como Usar

Execute o script com o comando `node`, seguido do nome do arquivo e do termo que deseja pesquisar.

**Exemplo Básico:**
```bash
node scrape-mercadolivre.js "iphone 15"
```

**Exemplo com termo simples:**
```bash
node scrape-mercadolivre.js whey
```

> **Nota:** Se o termo de pesquisa tiver espaços, é importante usar aspas duplas (`""`) ao redor dele.

## Arquivos Gerados

A cada execução, o script gera dois arquivos na raiz do projeto (que são ignorados pelo Git):

1.  `scraped-termo-timestamp.json`: O arquivo JSON contendo a lista de produtos encontrados e seus detalhes.
2.  `debug-termo-timestamp.html`: O HTML completo da página no momento da extração (útil para verificar se o layout do site mudou).