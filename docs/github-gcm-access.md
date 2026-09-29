# Access GitHub with Git Credential Manager

The harness uses the **host** Git Credential Manager (GCM) for private GitHub repositories. It does not store a PAT in its configuration or expose credentials to the model.

1. Install Git with GCM and sign in **outside the harness**: `git credential-manager github login`. On Windows, Git for Windows normally includes GCM. Your GitHub account must have access to the repository; organization policies may require additional authorization.
2. To clone or fetch a private repository, explicitly request the Git operation and use `run_command` with `execution_target: "host"`, e.g. `git clone https://github.com/OWNER/REPO.git repo-dir`. Git invokes the host's GCM. Do not place passwords or tokens in commands or URLs. Git operations are still subject to intent, workspace scope, host policy and approval. Public operations may use the default `auto` sandbox; GCM is not mounted into Docker.
3. To read a private repository root, tree, file, issue, PR or GitHub REST endpoint, use `web_fetch` (or `read_url_content`) with `github_auth: "gcm"`. Authenticated calls go to `api.github.com` only, without redirects or a shared cache. GitHub `blob`/`tree` URLs support a single-segment ref; use an explicit `api.github.com/repos/OWNER/REPO/...` URL for branch names containing slashes. The response is limited to 1 MB; paginate API listings explicitly if needed.

If the harness returns `GITHUB_CREDENTIAL_UNAVAILABLE`, sign in on the host before retrying. A `GITHUB_ACCESS_DENIED` result can mean a missing repository permission, invalid/expired credential or an organization access restriction. Interactive sign-in is intentionally not launched by a tool call. Public `web_fetch` continues to use `github_auth: "none"` by default.
