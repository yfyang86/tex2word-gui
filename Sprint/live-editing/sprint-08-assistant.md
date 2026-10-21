# Sprint 08 — A usable Assistant

## Goal

The old assistant was a toy:

- one provider and model per config file, with no way to change them in the app;
- a single "ask" box;
- replies you had to copy by hand;
- skills only through `manage.py`.

This sprint makes it a working tool:

1. **Providers and models** are configured in the app, and API keys are stored
   safely.
2. **The chat runs an agent.** It reads the project and proposes edits, and you
   review the edits before anything is written.
3. **Skills and saved prompts** get full create / read / update / delete
   management.

## What changed

**Providers** (`providers.py`, `secretbox.py`, settings → Providers)
- Providers come from `config.toml` plus the database. Editing a config
  provider in the app stores an override row field by field. "Reset" drops the
  row and restores the config values.
- Each provider has a **model list**, for example `luna` and `astra` for an
  OpenAI-style API, or DeepSeek's `deepseek-flash` and `deepseek-pro`, plus a
  default model.
  - **Fetch models** reads the provider's `/models` endpoint into suggestions.
  - **Test connection** sends a one-word probe and reports latency or the
    error.
- Presets fill in the API base and key variable: OpenAI, Anthropic, DeepSeek,
  OpenRouter, Kimi, Ollama and vLLM.
- **Keys are write-only.** An API key entered in the app is encrypted with
  AES-256-GCM before it is stored.
  - The master key comes from `TEX2WORD_SECRET_KEY` or a `0600` key file
    (`[security] secret_key_path`, created on first use and gitignored).
  - Each ciphertext is bound to its provider's name.
  - The API never returns a key. Managers see only its last four characters,
    and only for keys of 12 characters or more.
  - A provider can also read its key from an environment variable.
- With `[auth]` on, only admins change providers, defaults, settings and
  skills.

**LLM layer** (`llm.py`)
- One tool-calling interface over OpenAI-compatible APIs and Anthropic. It
  produces normalized events (text, reasoning, tool_call, usage, done).
- If a model rejects tools, the request is retried without them, with a notice.
- A server that rejects `stream_options` gets the request again without it.

**Agent** (`agent.py`, `POST /api/conversations/{cid}/agent`)
- A loop in the style of the pi agent, written in Python, with project tools
  and **no shell**:
  - `list_files`, `read_file`, `search`, `outline`;
  - `check`, which runs a tex2word conversion and reports its warnings;
  - `edit_file` (exact find/replace) and `write_file`.
- Edits land in a staged copy of the project, so the agent sees its own changes
  and nothing is saved yet. The turn ends with a change set.
- **Review:**
  - Apply all, Reject, or apply/reject per file, each with a diff.
  - A file edited since the agent read it is flagged as a conflict, and you
    choose "Overwrite".
- Runs are capped at 12 steps by default (configurable 1–40). The UI shows
  steps, thinking, token usage, model and time.
- **Chat mode** answers without tools.

**Chat UI** (`assistant-ui.js`, `markdown.js`)
- Live streaming with **Stop**. The partial reply is kept.
- Markdown rendering that is safe while still streaming. Code blocks have Copy
  and Insert at the cursor.
- Context chips:
  - the open file, which you can toggle;
  - the selected lines, which you can dismiss;
  - `@file` mentions.
- Copy, regenerate, edit & resend (which truncates the chat after that point).
- A conversation menu: switch, rename, delete.
- The model picker lists every enabled provider and model. Agent / Chat is a
  toggle.
- Keys: Enter sends, Shift+Enter adds a new line, Esc stops; `/` picks a skill
  and `@` a file.

**Skills and prompts** (`skills.py`, `prompts.py`, settings → Skills / Prompts)
- Skills are templates with `{file}`, `{selection}` and `{input}`, plus a mode
  (agent or chat).
  - Built-ins (`/fix`, `/polish`, `/explain`) are read-only and can be
    duplicated.
  - Custom skills are fully editable.
- Saved prompts are reusable snippets, picked from the composer.
- Settings → Behaviour sets standing instructions, the default mode and max
  steps, and shows the system prompt.

## Tests

- `tests/test_providers.py`:
  - encryption round trip and context binding;
  - key file permissions;
  - overrides and reset;
  - write-only keys and validation.
- `tests/test_llm_chat.py`: message and tool conversion for both APIs, plus the
  no-tools and no-`stream_options` fallbacks.
- `tests/test_agent.py`: workspace staging, every tool, the loop, step limits,
  the API turn, applying changes, conflicts, truncation.
- `tests/test_security.py`: assistant configuration is admin-only with auth on.
- `tests/js/markdown.test.js`: blocks, inline, escaping, streaming fences.
- `tests/e2e/assistant.e2e.js` (5) against a fake OpenAI server
  (`tests/e2e/fake_llm.js`):
  - the agent reads and edits a file, and the user applies the change;
  - Markdown, code actions, regenerate;
  - Stop, edit & resend, switching conversations;
  - provider, model and key management;
  - skill and prompt create / edit / delete and use.
