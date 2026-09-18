1. brew install localstack/tap/lstk
2. ```
   localstack auth set-token <YOUR_AUTH_TOKEN>
   SET LOCALSTACK_AUTH_TOKEN=ls-hofAleLA-jaja-5721-5117-vaKeGUPUd3a8 localstack start
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

- https://docs.localstack.cloud/aws/getting-started/installation/?__hstc=108988063.19d9e93d284c9bc7e8c6ecf117071587.1789707508244.1789707508244.1789707508244.1&__hssc=108988063.13.1789707508244&__hsfp=f0f56ff13b674a5efe5f00d477d19eac
