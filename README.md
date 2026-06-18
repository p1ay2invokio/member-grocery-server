# server

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Docker Deployment

### 1. Build and Run
To build and run the container in the background:
```bash
docker compose up -d --build
```

This will run the server and expose:
* **Elysia API**: Port `3019` on the host (mapped to internal `3001`)
* **Socket.io**: Port `3020` on the host (mapped to internal `3002`)

### 2. Database Connection
By default, the server is configured to connect to the PostgreSQL database running on the host at port `5444` via `host.docker.internal`.
If your database connection is different, you can configure it by creating a `.env` file on the production server or by specifying `DATABASE_URL` as an environment variable in `docker-compose.yml`.

### 3. Sync Database (Prisma db push)
If you need to push schema changes to the database:
```bash
docker compose exec server bunx prisma db push
```

