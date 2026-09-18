1. brew install localstack/tap/lstk
2. ```
   localstack auth set-token <YOUR_AUTH_TOKEN>
   SET LOCALSTACK_AUTH_TOKEN=aaa localstack start
   ```
3. docker run \
   --rm -it \
   -p 127.0.0.1:4566:4566 \
   -p 127.0.0.1:4510-4559:4510-4559 \
   -p 127.0.0.1:443:443 \
   -e LOCALSTACK_AUTH_TOKEN=${LOCALSTACK_AUTH_TOKEN:?} \
   -v /var/run/docker.sock:/var/run/docker.sock \
   localstack/localstack

3.1 docker compose --env-file .env -f docker/docker-compose.yml up -d --force-recreate localstack
