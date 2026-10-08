# Publish the documentation

The documentation is built with MkDocs Material and hosted as a static site on
Cloudflare Pages. The GitHub Actions workflow builds every documentation change
and deploys it to Pages when changes are pushed to `main`.

## Configure automatic deployment

The `Documentation site` workflow in `.github/workflows/docs.yml` builds the
`site/` directory and uploads it to the existing Pages project `typsastra-docs`.
Pull requests run the strict build check; pushes to `main` also deploy.

Add these repository Actions secrets in GitHub under **Settings → Secrets and
variables → Actions**:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An account API token with Cloudflare Pages edit access for the account containing `typsastra-docs` |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID that owns `typsastra-docs` |

Create the token from the account's [API Tokens page](https://dash.cloudflare.com/?to=/:account/api-tokens), not the user profile's API Tokens page. Keep it in GitHub Secrets; never commit it. Cloudflare's [Pages CI deployment guide](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/) has the token setup steps.

`wrangler.toml` identifies the Pages project and output directory. The workflow
uses `wrangler pages deploy`; do not use `wrangler deploy`, which targets
Workers.

To use `docs.typsastra.com`, add it under **Custom domains** for the
`typsastra-docs` Pages project. Cloudflare provisions HTTPS and configures the
DNS record when the domain is on Cloudflare DNS.

The `site_url` in `mkdocs.yml` and the root `README.md` already use
`https://docs.typsastra.com/`.

## Build locally

```bash
python -m pip install -r requirements-docs.txt
mkdocs serve
```

Open the local address printed by MkDocs to preview edits. Before publishing,
run:

```bash
mkdocs build --strict
```

The generated `site/` directory is a build artifact and should not be committed.
