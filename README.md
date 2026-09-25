# YouTube Comments Extractor

Extensao Chrome Manifest V3 para carregar comentarios de um video do YouTube, expandir respostas e exportar um JSON.

## Como instalar

1. Abra `chrome://extensions`.
2. Ative `Modo do desenvolvedor`.
3. Clique em `Carregar sem compactacao`.
4. Selecione esta pasta.
5. Abra um video em `https://www.youtube.com/watch...`.
6. Clique no icone da extensao e depois em `Extrair e baixar JSON`.

## Modos de extracao

- `API interna (recomendado)`: le o token de continuacao da propria pagina e pagina os comentarios pelo endpoint `/youtubei/v1/next`, incluindo as respostas de cada thread (quando a pagina nao entrega o token das respostas, a extensao monta o token). Precisa do popup aberto durante a coleta; se o YouTube recusar a requisicao ou o token nao existir, cai sozinho para o modo DOM.
- `DOM (rolagem da pagina)`: rola a pagina (ou o painel de comentarios), expande as respostas clicando em "ver respostas" e le o que estiver renderizado. E o fallback do modo API.

## Formato do JSON

No topo do arquivo ficam `title`, `url`, `videoId`, `mode` (`api` ou `crawler`), `totalThreads`, `totalReplies`, `visibleCommentCount` e `expectedCommentCount` (o total informado pelo proprio YouTube, usado para validar se a coleta parou cedo).

O `mode` tambem aparece no nome do arquivo baixado (`...-api-<timestamp>.json` ou `...-crawler-<timestamp>.json`), para dar para saber de onde veio o resultado sem abrir o JSON.

Cada comentario principal aparece em `data`.

Cada resposta aparece dentro de `replies` e inclui os campos que ligam a resposta ao comentario pai:

```json
{
  "commentId": "reply-id",
  "author": "Autor da resposta",
  "content": "Texto da resposta",
  "parentCommentId": "parent-id",
  "parentAuthor": "Autor do comentario pai",
  "parentContentPreview": "Preview do comentario pai",
  "replyIndex": 1,
  "isReply": true
}
```

O resultado tambem fica disponivel no console da pagina como `window.__YT_COMMENTS__`.

## Desenvolvimento

```bash
npm test
```
