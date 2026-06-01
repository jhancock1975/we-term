# we-term
Terminal client that runs in the browser and uses web sockets to tunnel ssh 

## Deployment

Run `./deploy.sh` from the repository checkout on the target machine. It:

- runs `npm run build` only if the repo defines a build script
- creates a deployment tarball under `.deploy/dist/`
- creates or updates `venv` and installs `requirements.txt`
- syncs `we-term.service` into systemd and reloads it when needed
- starts or restarts `we-term` only when the packaged app, dependencies, or unit file changed
