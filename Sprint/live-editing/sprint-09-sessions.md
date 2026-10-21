# Sprint 09 — Assistant sessions

## Goal

Make chat and agent sessions manageable:

1. **CRUD.** Find, open, rename, pin, duplicate, export and delete sessions.
2. **Branches.** Editing a message or regenerating a reply keeps the old
   version. You choose which version to show, and you can split any point into
   a new session.
3. **Remembered settings.** Each session keeps its own model and mode. Changing
   the model on a session with history warns first, because the prompt (KV)
   cache, the rolling summary and the context window are affected.

## What changed

**Message tree** (`chat.py`, `db.py`)
- Messages have a `parent_id`. A conversation's `head_id` is the last message
  of the branch on screen, and `Conversation.messages` is that branch (root →
  head). The model also sees only that branch.
- Edit & resend adds a sibling of the edited message. Regenerate adds a sibling
  reply under the same user message. Nothing is deleted.
- `select(mid)` shows the branch through a message and follows its newest
  continuation. `branches` lists every leaf, with its newest question, last
  reply, length and time.
- `delete_message` removes a message and everything below it. The head moves to
  the remaining branch.
- **Rolling summary per branch:** the summary remembers the last message it
  covers (`summary_anchor`). It is reused only on a branch that contains that
  message.
- **Upgrade:** chats from before branching are linked in their old order on
  first start.

**Sessions** (`sessions_api.py`)
- Each conversation stores:
  - `settings` (provider, model, mode);
  - `pinned`;
  - `forked_from`, for a split or duplicate.
- Create (with settings), list (pinned first, `?q=` searches titles and message
  text), get, `PATCH` (title, pin, settings merged key by key), delete.
- `POST …/fork` copies the branch up to a message, or the whole branch on
  screen for a duplicate, into a new session.
- `POST …/select`, `DELETE …/messages/{mid}`, and `GET …/export`, which
  downloads the branch on screen as Markdown.
- `POST …/switch-check` reports what moving the session to another model costs.
  Each warning has a kind and a level:
  - **cache**: the new model can't reuse the prompt / KV cache, so the next
    turn re-reads about *N* tokens (estimated from the text and the last turn's
    input usage);
  - **memory**: past the history budget, the new model gets the early turns as
    a summary written for the old one;
  - **context**: a chat of 24k+ tokens may not fit a smaller context window;
  - **tools**: Agent mode on a provider with tool use off runs as plain chat;
  - **provider** (info): reasoning traces, provider-side caches and token
    counts don't carry over;
  - **missing**: the session's old model is no longer set up.
- Agent turns accept two new fields:
  - `parent_id`: a message id, or `"root"` for a new first message;
  - `regenerate`: a user message id.
- Each turn records the model (and the mode, when chosen) in the session's
  settings. A reply on a different model carries `switched_from`.

**UI** (`assistant-ui.js`)
- **Sessions menu** (click the title):
  - search, `+ New`, and per session its mode icon, model, message and branch
    counts and time;
  - actions: pin, rename, duplicate, export, delete.
- **Versions:** `‹ 2/3 ›` on any message with other versions. The **branches**
  button (top bar, shown when a session has more than one) lists every branch
  and switches to it.
- **Split** on any message opens a new session holding the conversation up to
  there. It shows "Split from …", with a link back to the original.
- Delete a message and its replies.
- Opening a session restores its model and mode. New sessions start from the
  last ones picked.
- Changing the model shows the warnings with three choices:
  - **Switch** (saved to the session);
  - **New session on the new model** (a copy);
  - **Keep** the old model.
  Sending a message also counts as switching.
- A "Model changed: luna → astra" divider marks where a branch moves to another
  model.

## Tests

- `tests/test_sessions.py` (9):
  - branches from edit and regenerate;
  - select, and the history the model sees per branch;
  - deleting a subtree;
  - the per-branch summary;
  - fork, settings, pin, search, export;
  - upgrading old flat chats;
  - the sessions API (CRUD, select, fork, delete message, export with a
    Unicode title);
  - regenerate / edit / split over the agent API;
  - remembered settings and every switch warning.
- `tests/e2e/sessions.e2e.js` (3), against the fake OpenAI server (which now
  numbers `echo:` replies):
  - regenerate and edit, the version arrows, the branches menu, reload,
    deleting a turn;
  - split, then manage sessions: pin, search, rename, export (the file's
    contents), duplicate, delete, the link back;
  - the switch warning (keep / switch / new session), the divider, and
    restoring each session's model and mode.
