---
status: accepted
---

# Skill files live in Postgres

A Skill is a folder of files, kept as versions, that the worker must copy into an Agent's sandbox. Postgres is the only infrastructure Orqestra runs, so each version and its files are stored there (contents as `bytea`), not in object storage or on a volume shared by web and worker. An upload is capped at 10 MB unzipped and 200 files, which keeps this cheap; if Skills ever need to be much larger, move file contents to S3-compatible storage and keep only the index in Postgres.
