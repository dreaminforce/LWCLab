# LWable

LWable lets you describe a Lightning Web Component in natural language and preview usable source code in seconds. The project couples a Lightning Web Runtime (LWR) single-page app with a lightweight Node API that calls to OpenAI.

[LWable.webm](https://github.com/user-attachments/assets/27a9e5f8-68cb-41d5-93cf-80adb946fe3d)



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
- Deploy component to Salesforce Org.
- Use Structured Outputs
