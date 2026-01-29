# Graph Mind (Obsidian plugin)

Graph Mind turns your vault into a local, private knowledge search and chat experience. It indexes your Markdown notes, ranks relevant passages, and lets you ask questions in a dedicated chat view with citations to your notes.

## What this plugin does

- Builds a local index of your vault’s Markdown notes.
- Supports advanced search filters (tags, path, extensions, exact phrases).
- Reranks results with local embeddings for better relevance.
- Lets you chat with your vault in a side panel and jump to cited notes.
- Runs locally; no cloud dependency is required.

## Requirements

To use chat and semantic search, you need a local Ollama server running on your machine with at least:
- One chat model (for answers).
- One embedding model (for semantic search).

If Ollama is not running, the plugin can still open the UI but it won’t be able to generate answers or embeddings.

## Install

Manual install:
1. Copy `main.js`, `manifest.json`, and `styles.css` into:
   `VaultFolder/.obsidian/plugins/graph-mind/`
2. Reload Obsidian.
3. Enable the plugin in **Settings → Community plugins**.

## Quick start

1. Open **Settings → Graph Mind**.
2. Set the **Ollama base URL** (default is `http://localhost:11434`).
3. Pick your **LLM model** and **Embedding model**.
4. Use the ribbon icon (bot) or the command **Open Graph Mind chat** to open the chat view.
5. Ask a question and review the cited sources.

## User guide

### Commands

- **Build Graph Mind index**: Rebuilds the full vault index.
- **Open Graph Mind chat**: Opens the chat view in the right sidebar.

### Chat view

- Ask questions in natural language.
- The plugin first searches your vault, then generates an answer based on top results.
- Citations appear as numbered links that open the source notes.

### Advanced search syntax

You can use filters inside questions to refine search:

- Exact phrase: `"project kickoff"`
- Tag: `#meeting`
- File extension: `ext:md`
- Path include: `path:Projects/2025`
- Path exclude: `-path:Archive`
- Exclude word: `-draft`

Example:
```
"design review" #ux path:Projects/2025 -draft
```

## Tips

- Use **Build Graph Mind index** after major changes or large imports.
- If results feel off, check your embedding model in settings.
- Keep short, focused notes for better search precision.

## Privacy

Your notes stay on your device. The plugin indexes locally and only communicates with the Ollama server you configure in settings (the **Ollama base URL**) to generate chat responses and embeddings.

## License

GNU General Public License v3.0 (GPL-3.0-only). See `LICENSE`.

## Third-party licenses

This plugin includes the following third-party libraries (license as reported by their package metadata):

- @mastra/rag — Apache-2.0
- @xenova/transformers — Apache-2.0
- minisearch — MIT
- nodejieba — MIT
- ollama — MIT
- onnxruntime-web — MIT
- path-browserify — MIT
- voy-search — MIT OR Apache-2.0
