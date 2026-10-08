# Publish the documentation

The documentation is built with MkDocs Material and hosted as a static site on
Cloudflare Pages. Markdown remains in this repository; Cloudflare rebuilds the
site when changes are pushed to `main`.

## Cloudflare Pages setup

1. In Cloudflare, open **Workers & Pages → Create → Pages → Connect to Git** and
   select the `Sovichea/typsastra` repository.
2. Configure the build:

   | Setting | Value |
   | --- | --- |
   | Production branch | `main` |
   | Build command | `pip install -r requirements-docs.txt && mkdocs build --strict` |
   | Build output directory | `site` |

   `wrangler.toml` names the Pages project `typsastra-docs` and declares the
   `site` output directory.
3. Save and deploy. Cloudflare builds the site on each push to `main` and
   provides preview deployments for pull requests.
4. In the Pages project, open **Custom domains** and add
   `docs.typsastra.com`. Cloudflare will provision HTTPS and configure the DNS
   record when the domain is on Cloudflare DNS.

After the custom domain is selected, update `site_url` in `mkdocs.yml` and the
documentation link in the root `README.md` to that exact URL.

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
