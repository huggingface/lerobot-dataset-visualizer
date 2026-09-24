# Visualizing local datasets

View LeRobot datasets straight from **local disk** (instead of the HuggingFace Hub):

```bash
bun install
bun run local /path/to/your/datasets      # a dataset dir, or a folder of them
```

`bun run local` configures and starts the app for you:

- **A single dataset** → `http://localhost:3000/` opens straight on it.
- **A folder of datasets** → it prints each dataset's URL for you to open.

A "dataset dir" is any folder with `meta/info.json` (LeRobot v2.0 / v2.1 / v3.0). Use a
different port with `bun run local /path --port 8080`. On a remote machine, forward the
app port your tooling assigns — that's the only port needed.
