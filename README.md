# LWable

LWable lets you describe a Lightning Web Component in natural language and preview usable source code in seconds. The project couples a Lightning Web Runtime (LWR) single-page app with a lightweight Node API that calls to OpenAI.



https://github.com/user-attachments/assets/d0b926ce-a536-444d-9088-e398790de939




## What Happens After You Clone
- `src/modules/app/shell` renders the chat-style UI you will use to describe the component you want.
- `api/server.mjs` runs on port 3001 and talks to OpenAI to generate HTML/JS/CSS for the preview.
- The generated files land in `src/modules/gen/preview` so the LWR runtime can immediately render the new component.

## Prerequisites
- Node.js 18 or newer (the project is pinned to Node 20.16.0 via Volta).
- npm for dependency management.
- An OpenAI API key with access to the `gpt-4o-mini` model.

## Initial Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file at the project root with your OpenAI credentials:
   ```bash
   OPENAI_API_KEY=sk-...
   ```
   Keep this file out of version control; `.gitignore` already excludes it.

## Run the App Locally
- **One command for both servers**
  ```bash
  npm run start:all
  ```
  This runs the LWR dev server on http://localhost:3000 and the API server on http://localhost:3001.


Once both processes are up, open http://localhost:3000. Enter a prompt in the chat panel, click **Generate**, and the preview pane will refresh with the latest component. The last conversation and code snapshot are cached in `sessionStorage` so a browser refresh keeps your progress.

## Deploy to Salesforce
1. Generate a component so the preview pane shows the latest HTML/JS/CSS.
2. Click **Deploy to Salesforce** in the preview header.
3. Choose a Lightning web component name (letters, numbers, underscores; must start with a letter) and tick the surfaces you want to expose (`lightning__AppPage`, `lightning__HomePage`, `lightning__RecordPage`).
4. Enter your Salesforce username and password (append your security token if your org requires one).
5. The server logs in with jsforce, bundles the generated source, and deploys it using the Metadata API.

**Environment variables**
- `SF_LOGIN_URL` (optional): override the login endpoint (use `https://test.salesforce.com` for sandboxes).
- `SF_API_VERSION` (optional): defaults to `60.0` if not set.
- `SF_DEPLOY_TIMEOUT_MS` (optional): override the deploy wait timeout (defaults to 300000 ms).

Credentials are sent only to your local API server and are never stored.

## Daily Workflow Tips
- Every time you generate, the files in `src/modules/gen/preview` are overwritten. I've added them to gitIgnore so that they don't bug you on every refresh.
- The API sanitises generated markup to enforce valid LWC semantics; check the terminal logs if a prompt fails.

## Troubleshooting
- Missing API key? The API server will exit with "401 Unauthorized" style errors; double-check `.env` and restart.
- Model errors from OpenAI appear in the API console; inspect the stack trace there first.
- Port clashes on 3000 or 3001? Stop the conflicting service or update the scripts in `package.json` to use open ports.

## Roadmap
- Chat UI to look more like Chatting.
- Download LWC Option.
- [x] Deploy component to Salesforce Org.
- Use Structured Outputs
