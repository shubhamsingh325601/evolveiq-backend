# Production deploy (Hostinger VPS)

The VPS is shared with other live sites. EvolvIQ only adds its own pieces:

| Piece | Where on the server |
|---|---|
| API + PostgreSQL 16 (Docker Compose project `evolviq`) | `/opt/evolviq/app` (source), `/opt/evolviq/app/deploy/.env` (secrets) |
| Frontend builds | `/var/www/evolviq/{school-web,admin-panel,family-web,student-web}` |
| Nginx sites | `/etc/nginx/sites-available/<domain>` (the files in `deploy/nginx/`) |

| Address | App |
|---|---|
| `api.evolviq.in` | this API |
| `teacher.evolviq.in` | school-web (teachers, psychologists) |
| `system-admin.evolviq.in` | admin-panel (school admins, platform admin) |
| `family.evolviq.in` | family-web built with `VITE_FAMILY_AUDIENCE=parents` → `family-web/` |
| `student.evolviq.in` | family-web built with `VITE_FAMILY_AUDIENCE=students` → `student-web/` |

The two family builds are separate installable apps (PWA). Build each with its own
`VITE_FAMILY_AUDIENCE` and `VITE_FAMILY_OTHER_URL` (the other site, for the link on the
sign-in screen), one after the other: both write to `apps/family-web/dist`.

**Temporary hostnames (until evolviq.in's .IN KYC is done):** the sites run on the VPS's own
Hostinger hostname, `{api,teacher,system-admin,family}.srv1833617.hstgr.cloud`. Their Nginx
files are the `deploy/nginx/*.evolviq.in` files with `evolviq.in` replaced by
`srv1833617.hstgr.cloud` and the zone renamed `evolviq_login_hstgr`; certbot cert name
`evolviq-hstgr`. To switch to evolviq.in later: install the `deploy/nginx` files as they are,
run certbot for the four evolviq.in names, rebuild the frontends with
`VITE_API_BASE_URL=https://api.evolviq.in/api/v1`, then remove the `*.hstgr.cloud` sites.
`CORS_ORIGINS` already lists both sets of origins.

The API listens on `127.0.0.1:3000` (Nginx only). PostgreSQL has no published port.
Data lives in the Docker volume `evolviq_pgdata`. Never edit the other sites' Nginx
files, and always run `nginx -t` before `systemctl reload nginx`.

## Update the backend

From the backend repo on your PC:

```sh
tar -czf - --exclude='src/generated' --exclude='*.test.ts' package.json package-lock.json \
  prisma.config.ts prisma tsconfig.json tsconfig.build.json src scripts Dockerfile \
  .dockerignore deploy/docker-compose.prod.yml deploy/nginx \
  | ssh root@<vps> 'tar -xzf - -C /opt/evolviq/app'
```

On the server:

```sh
cd /opt/evolviq/app/deploy
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec -T api npx prisma migrate deploy
docker compose -f docker-compose.prod.yml logs api --tail 20
```

## Update a frontend

Build in the frontend repo with the production API URL, then copy `dist/` over:

```sh
VITE_API_BASE_URL=https://<api-domain>/api/v1 VITE_SHOW_DEMO_ACCOUNTS=false \
  pnpm --filter @evolveiq/school-web build
tar -czf - -C apps/school-web/dist . | ssh root@<vps> 'tar -xzf - -C /var/www/evolviq/school-web'
```

## Secrets (`deploy/.env` on the server only)

`NODE_ENV=production`, `DB_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`CORS_ORIGINS` (the three frontend origins), `API_DOCS_ENABLED=false`, plus the other
variables in `.env.example`. After changing it: `docker compose -f docker-compose.prod.yml up -d api`.

Password-reset emails go out through Resend, as `no-reply@evolviq.in` (evolviq.in is verified in
Resend; its DNS records are at GoDaddy, beside the Titan mailbox records, which they do not touch):
`SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465`, `SMTP_USER=resend`,
`SMTP_PASSWORD=<a Resend API key with Sending access to evolviq.in>`, `MAIL_FROM=EvolvIQ <no-reply@evolviq.in>`. Without
`SMTP_HOST` the API still starts but logs a warning, and no reset email can be sent.

## Backup

```sh
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U evolviq evolviq | gzip > evolviq-$(date +%F).sql.gz
```
