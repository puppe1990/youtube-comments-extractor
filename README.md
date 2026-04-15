# YouTube Comments Extractor

Extensao Chrome Manifest V3 para carregar comentarios de um video do YouTube, expandir respostas e exportar um JSON.

## Como instalar

1. Abra `chrome://extensions`.
2. Ative `Modo do desenvolvedor`.
3. Clique em `Carregar sem compactacao`.
4. Selecione esta pasta.
5. Abra um video em `https://www.youtube.com/watch...`.
6. Clique no icone da extensao e depois em `Extrair e baixar JSON`.

## Formato do JSON

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
