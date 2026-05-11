# Sistema de backup

Backup diario automático de **DB + código Lambda + frontend S3 + config AWS**, disparado por GitHub Actions y almacenado en S3 con lifecycle a Glacier.

## Arquitectura

```
GitHub Actions cron (04:00 UTC)
      │
      ├── invoca → Lambda prode-backup (dentro del VPC)
      │              └── pg dump SQL → s3://prode-backups/db/YYYY-MM-DD/
      │
      ├── descarga zip de Lambda prode-api → s3://prode-backups/lambda/YYYY-MM-DD/
      ├── exporta env vars de prode-api    → s3://prode-backups/lambda/YYYY-MM-DD/prode-api-config.json
      ├── sync del frontend                → s3://prode-backups/frontend/YYYY-MM-DD/
      └── manifest                         → s3://prode-backups/manifests/YYYY-MM-DD.json
```

## Por qué este diseño

- La RDS está en VPC privada → GitHub Actions no se puede conectar directo. La Lambda corre **dentro** del VPC reusando los subnets/SG de `prode-api`, así que ve la DB sin abrir nada al mundo.
- El dump es SQL plano (gzippeado) generado en Node.js leyendo `information_schema` + `SELECT *`. No requiere binario `pg_dump` en Lambda. Restore con `psql -f`.
- S3 con lifecycle: 30 días en Standard → Glacier IR → expira a 365 días. Versionado activo (versiones viejas expiran a 90).

## Setup inicial (una sola vez)

Necesitás `aws` CLI configurado con credenciales que tengan permisos sobre IAM, Lambda y S3.

```bash
# 1. Crear el bucket S3
bash backup/scripts/setup-bucket.sh

# 2. Crear la Lambda prode-backup (lee config de VPC/DB de prode-api automáticamente)
cd backup/lambda
bash deploy.sh --create
cd ../..

# 3. Probar manualmente
aws lambda invoke \
  --function-name prode-backup \
  --region us-east-1 \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  /tmp/out.json && cat /tmp/out.json

# 4. Verificar en S3
aws s3 ls s3://prode-backups/db/ --recursive
```

## Setup en GitHub

El workflow `.github/workflows/backup.yml` necesita estos **secrets** (Settings → Secrets and variables → Actions):

| Secret | Valor |
|--------|-------|
| `AWS_ACCESS_KEY_ID` | (mismo que usa `deploy.yml`) |
| `AWS_SECRET_ACCESS_KEY` | (mismo que usa `deploy.yml`) |

Las credenciales necesitan estos permisos mínimos:
- `lambda:InvokeFunction` sobre `prode-backup`
- `lambda:GetFunction`, `lambda:GetFunctionConfiguration` sobre `prode-api`
- `s3:GetObject`, `s3:ListBucket` sobre `prodecaballito-fe`
- `s3:PutObject`, `s3:ListBucket` sobre `prode-backups`

## Disparar manual

Desde la UI de GitHub: Actions → "Backup diario" → Run workflow. Permite saltar componentes individuales (DB, Lambda, frontend).

## Restore

```bash
# Setear credenciales DB en env
export DB_HOST=prode-db.c850syqeokik.us-east-1.rds.amazonaws.com
export DB_USER=...
export DB_PASSWORD=...
export DB_NAME=...

# DB completa (pide confirmación, hace TRUNCATE + re-INSERT)
bash backup/scripts/restore-db.sh db/2026-05-11/prode-2026-05-11T04-00-00-000Z.sql.gz

# Código Lambda prode-api a una fecha
bash backup/scripts/restore-lambda.sh 2026-05-11

# Frontend (con invalidación CloudFront opcional)
export CLOUDFRONT_DISTRIBUTION_ID=E...
bash backup/scripts/restore-frontend.sh 2026-05-11
```

Los scripts de restore piden escribir `RESTAURAR` antes de hacer cambios destructivos.

## Costo estimado

Asumiendo DB de ~50MB, frontend de ~10MB, Lambda zip de ~30MB:

- 30 días en S3 Standard: 30 × 90MB = 2.7GB × $0.023 = **$0.06/mes**
- Después en Glacier IR: 11 meses × 2.7GB × $0.004 = **$0.12/año**
- Lambda invocations: 30/mes × ~5s × 1024MB = **<$0.01/mes**

Total: **<$0.20/mes**.

## Estructura de archivos

```
backup/
├── README.md                      ← este archivo
├── lambda/
│   ├── index.mjs                  ← Lambda handler (dump DB → S3)
│   ├── package.json
│   └── deploy.sh                  ← create/update de la Lambda
└── scripts/
    ├── setup-bucket.sh            ← crea bucket S3 con lifecycle
    ├── restore-db.sh              ← restore de DB desde S3
    ├── restore-lambda.sh          ← restore del código Lambda
    └── restore-frontend.sh        ← restore del frontend S3

.github/workflows/
└── backup.yml                     ← cron diario a las 04:00 UTC
```

## Limitaciones conocidas

- El dump no incluye índices (más allá de PRIMARY KEY), foreign keys, ni triggers. Asumo que el schema lo crean las migrations (`db/migrations/`). Para restore en DB nueva: correr migrations primero, después restore.
- Tablas con tipos custom (enums, composites) pueden requerir ajuste manual del CREATE TABLE generado.
- Si la DB crece >500MB, considerar usar `pg_dump` real vía un Lambda con container image y `dnf install postgresql15`.
