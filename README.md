# LWable

LWable lets you describe a Lightning Web Component in natural language and preview usable source code in seconds. The project couples a Lightning Web Runtime (LWR) single-page app with a lightweight Node API that can call either OpenAI or Google Gemini based on the model toggle in the UI.


[LWable.webm](https://github.com/user-attachments/assets/7b59522d-a3e2-4e45-a3bd-223e5dcfbf8a)


## What Happens After You Clone
- `src/modules/app/shell` renders the chat-style UI you will use to describe the component you want (and now hosts the OpenAI/Gemini toggle next to the title).
- `api/server.mjs` runs on port 3001 and talks to the selected provider to generate HTML/JS/CSS for the preview.
- The generated files land in `src/modules/gen/preview` so the LWR runtime can immediately render the new component.

## Prerequisites
- Node.js 18 or newer (the project is pinned to Node 20.16.0 via Volta).
- npm for dependency management.
- At least one supported AI key:
  - `OPENAI_API_KEY` with access to the `gpt-4.1-mini` model.
  - `GEMINI_API_KEY` with access to the `gemini-2.5-flash` model.
  (You can provide both keys and switch in the UI.)

## Initial Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file at the project root with the credentials you plan to use:
   ```bash
   OPENAI_API_KEY=sk-...
   GEMINI_API_KEY=ai-...
   ```
   Only one key is required, but supplying both lets you flip providers without editing env vars. Keep this file out of version control; `.gitignore` already excludes it.

## Run the App Locally
- **One command for both servers**
  ```bash
  npm run start:all
  ```
  This runs the LWR dev server on http://localhost:3000 and the API server on http://localhost:3001.

Once both processes are up, open http://localhost:3000. Use the toggle beside **LWC Generator** to choose OpenAI or Gemini, enter a prompt in the chat panel, click **Generate**, and the preview pane will refresh with the latest component. The last conversation and code snapshot are cached in `sessionStorage` so a browser refresh keeps your progress.

## Deploy to Salesforce
1. Generate a component so the preview pane shows the latest HTML/JS/CSS.
2. Click **Deploy to Salesforce** in the preview header.
3. Choose a Lightning web component name (letters, numbers, underscores; must start with a small letter) and tick the surfaces you want to expose (`lightning__AppPage`, `lightning__HomePage`, `lightning__RecordPage`).
4. Enter your Salesforce username and password (append your security token if your org requires one).
5. The server logs in with jsforce, bundles the generated source, and deploys it using the Metadata API.

**Environment variables**
- `SF_LOGIN_URL` (optional): override the login endpoint (use `https://test.salesforce.com` for sandboxes).
- `SF_API_VERSION` (optional): defaults to `60.0` if not set.
- `SF_DEPLOY_TIMEOUT_MS` (optional): override the deploy wait timeout (defaults to 300000 ms).

Credentials are sent only to your local API server and are never stored.

## Daily Workflow Tips
- Every time you generate, the files in `src/modules/gen/preview` are overwritten. I've added them to `.gitignore` so that they don't bug you on every refresh.
- The API sanitises generated markup to enforce valid LWC semantics; check the terminal logs if a prompt fails.
- The UI remembers your model selection in `sessionStorage`, so your provider choice survives refreshes.

## Troubleshooting
- Missing API key? The API server will exit with provider-specific errors; double-check `.env` and restart.
- Model errors bubble up in the API console (either from OpenAI or Gemini); inspect the stack trace there first.
- Port clashes on 3000 or 3001? Stop the conflicting service or update the scripts in `package.json` to use open ports.

## Roadmap
- [x] Chat UI to look more like Chatting.
- Download LWC Option.
- [x] Deploy component to Salesforce Org.
- Use Structured Outputs
- [x] Add more LLM providers (Gemini support via toggle)
