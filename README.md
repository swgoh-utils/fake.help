# fake.help

This is intended to be a transitional docker image that eases the process of
using the swgoh-comlink service to access the game data rather than api.swgoh.help.
It should be deployed "in front" or "inbetween" the swgoh-comlink service and
the client.  Existing api.swgoh.help API client stubs should function properly,
as long as they can be configured to use the correct protocol (http vs https),
host, and port.

The responses are formatted to be as close as reasonably possible to what is
returned from api.swgoh.help, but some values may not be the correct data
type.  However, error codes and messages are not emulated, so any error handling
based on the error responses cannot be expected to function properly.

# Caveats

- GP values are not calculated.  .help's GP values were already incorrect.  Use something like swgoh-stats to calculate unit GPs.
- using the enums parameter is not supported- the performance is terrible and implementing it is complicated (and annoying)
- The naive auth implementation can result in a corrupted tokens json file, you may need to manually clean it up
- the /roster and /units end points are not implemented because .help already had effectively deprecated them
- fake.help is *very* resource hungry because of emulating the mongo behavior from .help
- additional fields are spread into the response and passed through- this is in case you update your comlink and new fields appear
- similar to .help, fixes and improvements to fake.help are not planned or expected.  You should make a plan to migrate to using comlink directly.

# Authentication / Authorization

The /auth/signin end point provides a fake response, unless you specify the USERNAME and PASSWORD environment variables.  The Authorization header sent to each end point is only verified when the USERNAME and PASSWORD is set.  Keep in mind that this does not make it secure since everything will be sent in the clear, but it could help deter casual unwanted access.

If your swgoh-comlink service has enabled HMAC authentication, you must provide
the access key and secret to use to sign messages to the server.

# SSL/TLS

If you are configuring this service to be accessible over a network, you
may want to configure a reverse proxy such as nginx in front of it to provide
TLS encryption.  Although the majority of the data passed across the wire is
not sensitive due to it being "public", whatever login you pass to the
/auth/signin request would be sent in the clear.

# Environment Variables

- CLIENT_URL - the url of the swgoh-comlink service to use for fulfilling requests
- PORT - the port that the service will listen to
- ACCESS_KEY - the access key to use for signing messages to the swgoh-comlink service. Defaults to "" which disables HMAC signing.
- SECRET_KEY - the secret key to use for signing messages to the swgoh-comlink service. Defaults to "" which disables HMAC signing.
- USERNAME - used for the /auth/signin end point for issuing tokens.  If USERNAME and PASSWORD are omitted, the bearer auth token headers are ignored and all requests are permitted. Note: the auth implementation should not be considered "secure", it is only a bare minimum implementation to mimic api.swgoh.help's auth implementation.
- PASSWORD - used for the /auth/signin end point for issuing tokens.
- TOKEN_DURATION - sets the length of time auth tokens are valid for.  Default is 1 hour.
- CONCURRENT_PLAYERS - the amount of concurrent player fetch calls to ally per guild request, or for requests to the /swgoh/players end point
- CONCURRENT_GUILDS - the amount of concurrent guild fetch calls to allow during requests to /swgoh/guilds
- UPDATE_INTERVAL - how often to check for game data updates, in minutes.  Defaults to 5 minutes.
- PLAYER_CACHE_TIME - how long to keep fetched players in memory, in milliseconds.  This helps with repeated player requests, such as fetching a guild, then fetching all of the players in it.  Defaults to 30000
- NO_LOCALIZATION - used to disable localization bundle fetches on updates.  Use this if your app does not care about localized data.  Defaults to false.
- LANGUAGES - a comma separated list of the languages you want to keep in memory for localization. For example, `CHS_CN,ENG_US`.  Not applicable if NO_LOCALIZATION is set to true.  Defaults to `ENG_US`
- DATA_PATH - used to set the directory where game data assets and object maps for
formatting data are stored.  When run as a docker container, this should be defined as a volume with an absolute path on the local host, such as `-v $(pwd)/data:/app/data`.  The default value is the data/ directory in the current working directory, which in docker is /app.
- COMPRESSION - controls whether requests to the swgoh-comlink service enable compression for the response.  Defaults to `true`.
- USE_SEGMENTS - Fetches the game data using segments parameter. Fetching in segments may be less memory intensive, but may take longer.  Defaults to false.
- USE_UNZIP - Fetches the localization bundle game data as either a base64 string that needs to be unzipped, or a JSON object that has already been unzipped and processed.  Fetching as JSON is more memory intensive for the client.  Defaults to false (client does not request bundle as unzipped files in a json object).

# game data updates

The fake.help service requires game data files in order to format the raw
data response into the same format as api.swgoh.help.  On startup it will
check for updates and download any game data assets it requires before
listening for incoming requests.  To allow it to startup faster, you should
specify a volume so that the files it uses will be persisted, rather than
ephemeral and destroyed when the container stops.

Game data updates checks will happen on regular intervals as configured,
but can also be requested ad-hoc by a POST request to the /update end point.

# building with docker
docker build -t fake.help .

# running with docker

docker run --rm -it -p 3333:3333 --env-file .env fake.help

# sample .env file

```
NODE_ENV=production
PORT=3333
ACCESS_KEY=my-access-key
SECRET_KEY=my-secret-key
USERNAME=my-user
PASSWORD=my-pass
CLIENT_URL=http://localhost:3000
```

# example script for updating from gitlab docker repository

This script assumes that you set up a docker network ahead of time for fake.help and swgoh-comlink to communicate on, with a command like `docker network create swgoh-comlink`.  If you do not create a network for the containers to talk to each other, you will likely need to use the public IP of your docker host (the IP reported for eth0 in `ifconfig`) and ensure that any OS level firewall like `ufw` will permit the traffic.

```sh
docker pull ghcr.io/swgoh-utils/fake.help:latest
docker stop fake.help
docker rm fake.help
docker run --name=fake.help \
  -d \
  --restart always \
  --network swgoh-comlink \
  --env-file .env-fake.help \
  -p 3333:3333 \
  -u $(id -u):$(id -g) \
  -v $(pwd)/data:/app/data \
  ghcr.io/swgoh-utils/fake.help:latest
```