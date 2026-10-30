# Deploying the API to the shared AWS host

Host: Amazon Linux 2023, **ARM (Graviton)**, ~4 GB RAM, shared with other applications (nginx, Python and Node apps, MariaDB).
TokenGo lives only under `/var/www/html/jtsdgt/tokengo/` and in its own Docker project (`tokengo`, network `tokengo_internal`,
volume `tokengo_pgdata`). Nothing else on the host is touched.

```
tokengo/
  app/docker-compose.yml      (= docker/docker-compose.aws.yml)
  secrets/.env.stack          0600, generated ON the server by docker/gen-stack-env.mjs --mode prod-like; BACK IT UP
  backups/                    database dumps
```

## Images (built on a PC, never on the host: a build would starve the neighbours)
```
docker buildx build --platform linux/arm64 -f docker/Dockerfile.postgis -t tokengo-postgis:16 --load docker
docker buildx build --platform linux/arm64 -f apps/api/Dockerfile --target migrate -t tokengo-migrate:<tag> --load .
docker buildx build --platform linux/arm64 -f apps/api/Dockerfile -t tokengo-api:<tag> --load .
docker save tokengo-postgis:16 tokengo-migrate:<tag> tokengo-api:<tag> | gzip > tokengo-images-<tag>.tar.gz
# copy to the server, then:  gunzip -c tokengo-images-<tag>.tar.gz | sudo docker load
```
(The community `postgis/postgis` image is amd64 only, hence `docker/Dockerfile.postgis`.)

## Run / update / roll back
```
cd /var/www/html/jtsdgt/tokengo/app
sudo docker compose --env-file ../secrets/.env.stack up -d          # migrates first, then api + worker
sudo docker compose --env-file ../secrets/.env.stack ps
curl -s http://127.0.0.1:3100/api/v1/health/ready
# update: load the new images, set TOKENGO_TAG=<new> in ../secrets/.env.stack, run `up -d` again. Roll back: set the old tag.
# backup: sudo docker exec tokengo-postgres-1 pg_dump -U tokengo tokengo | gzip > ../backups/tokengo-$(date +%F).sql.gz
```
Migrations are forward-only: take a backup before an update that includes new migrations.

## What is deliberately switched off (production gates, `apps/api/src/shared-kernel/config.ts`)
`NODE_ENV=production`, so: `PAYMENT_PROVIDER=disabled`, `PAYOUT_PROVIDER=disabled` (no wallet top-ups until the compliance review),
`PUSH_PROVIDER=disabled` until Firebase files exist, `S3_BUCKET` is a placeholder (file uploads fail until a real bucket + IAM role),
and `SMS_PROVIDER=disabled` until the WhatsApp credentials are put in the secrets file and set `SMS_PROVIDER=whatsapp`
(then: `up -d` again). Rotate any credential that was ever pasted into a chat before using it here.

## Going public
Nothing is reachable from outside: the API binds to `127.0.0.1:3100`. When the API has a DNS name, install
`docker/nginx-tokengo.conf.example` as a NEW file in `/etc/nginx/conf.d/`, `sudo nginx -t`, reload, then `certbot --nginx -d <name>`.
Release builds of the mobile apps need that HTTPS address compiled in.

## Test configuration actually deployed (2026-10-30)
Because Razorpay TEST keys and sandbox payouts are refused when `NODE_ENV=production`, the server runs `NODE_ENV=development` with the
WhatsApp and Razorpay test settings copied from the local `apps/api/.env` into `secrets/.env.stack`. No real money: `REAL_MONEY_ENABLED=false`.
Plain HTTP on dedicated ports (API 3100, admin 3101) with the AWS security group as the gate; restrict the 3101 source to your own IP.
Admin portal: `sudo docker compose --env-file ../secrets/.env.stack --profile admin up -d admin`. First administrator:
`docker compose ... run --rm --no-deps -e ADMIN_PHONE=... -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... api node dist/cli/create-admin.js`.
To return to the production gates: restore `secrets/.env.stack.bak-prodlike` (and use HTTPS, a real S3 bucket and WhatsApp credentials).
