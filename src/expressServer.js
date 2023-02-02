const express = require('express');
const compression = require('compression')
const bodyParser = require('body-parser');
const helmet = require('helmet');
const crypto = require('crypto');

const utils = require('./utils');

const ComlinkStub = require('@swgoh-utils/comlink');
const comlinkStub = new ComlinkStub({
  url: process.env.CLIENT_URL,
  accessKey: process.env.ACCESS_KEY,
  secretKey: process.env.SECRET_KEY,
  compression: process.env.COMPRESSION || true
});

const dataPath = process.env.DATA_PATH || 'data';
const HelpFormatter = require('./helpFormatter');
const helpFormatter = new HelpFormatter({
  comlinkStub: comlinkStub,
  playerCacheTime: process.env.PLAYER_CACHE_TIME || 30000,
  concurrentPlayers: process.env.CONCURRENT_PLAYERS || 10,
  concurrentGuilds: process.env.CONCURRENT_GUILDS || 2,
  languages: process.env.LANGUAGES || 'ENG_US', // comma separated list
  noLocalization: process.env.NO_LOCALIZATION || false,
  useSegments: process.env.USE_SEGMENTS,
  useUnzip: process.env.USE_UNZIP,
  updateInterval: process.env.UPDATE_INTERVAL,
  dataPath: dataPath
});

let tokenMap = {};
const timeoutMap = {};
const AUTH_ERROR_CODE = 401;
const TOKEN_DURATION = process.env.TOKEN_DURATION || 3600;
const TOKEN_FILE_NAME = 'tokens';

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// use helmet to protect from various common security issues
app.use(helmet());

// compress all responses if Accept-Encoding header contains gzip
app.use(compression());

function getTimeUntil(epoch) {
  return (new Date(epoch)).getTime() - (new Date()).getTime();
}

function getTimeIn(seconds) {
  return new Date(new Date().getTime() + (seconds * 1000)).getTime();
}

async function removeToken(token, save = true) {
  const timeout = timeoutMap[token];
  if (timeout) {
    clearTimeout(timeout);
  }

  delete timeoutMap[token];
  delete tokenMap[token];

  if (save) {
    await saveTokens().catch((error) => {
      console.error(`Unable to save tokens: ${error.message}`);
    });
  }
}

function addTokenTimeout(token, epoch) {
  let msec = getTimeUntil(epoch);
  let removed = false;

  if (msec > 0) {
    timeoutMap[token] = setTimeout(() => {
      removeToken(token);
    }, msec);
  } else {
    const save = false;
    removed = true;

    removeToken(token, save);
  }

  return removed;
}

async function createToken(user) {
  let token = crypto.randomBytes(20).toString('hex');

  // link new token
  tokenMap[token] = getTimeIn(TOKEN_DURATION);
  addTokenTimeout(token, tokenMap[token]);

  await saveTokens().catch((error) => {
    console.error(`Unable to save tokens: ${error.message}`);
  });

  return token;
}

async function saveTokens() {
  try {
    console.debug('Saving tokens...');
    await utils.writeFile(dataPath, TOKEN_FILE_NAME, tokenMap);
  } catch(error) {
    throw(error);
  }
}

async function initTokens() {
  console.debug(`Loading tokens...`);
  try {
    let anyRemoved = false;
    tokenMap = await utils.readFile(dataPath, TOKEN_FILE_NAME);

    for (const [token, epoch] of Object.entries(tokenMap)) {
      let removed = addTokenTimeout(token, epoch);
      if (removed) {
        anyRemoved = true;
      }
    }

    if (anyRemoved) {
      await saveTokens();
    }
  } catch(error) {
    throw(error);
  }
}

app.post('/auth/signin', bodyParser.urlencoded({extended:false}), async (req, res, next) => {
  const user = req.body.username || 'none';
  const pass = req.body.password || '';

  try {
    if (process.env.USERNAME && process.env.PASSWORD &&
        (user !== process.env.USERNAME ||
        pass !== process.env.PASSWORD)) {
      res.status(AUTH_ERROR_CODE).json({
        code: AUTH_ERROR_CODE,
        error: 'Unauthorized',
        error_description: 'Unable to authenticate user'
      });
    } else {
      let token = await createToken(user);

      res.status(200).json({
        token_type: 'bearer',
        access_token: token,
        expires_in: TOKEN_DURATION
      });
    }
  } catch(error) {
    next(error);
  }
});

app.get('/version', async (req, res, next) => {
  try {
    res.status(200).json(await helpFormatter.getVersion());
  } catch(error) {
    next(error);
  }
});

// check for authorization token header if username and password are enabled
if (process.env.USERNAME && process.env.PASSWORD) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    const [type, token] = auth ? auth.split(' ') : [];
    if (type === 'Bearer' && tokenMap[token]) {
      next();
    } else {
      res.status(AUTH_ERROR_CODE).json({
        code: AUTH_ERROR_CODE,
        error: 'Unauthorized',
        error_description: 'User not authenticated'
      });
    }
  });
}

app.use(bodyParser.json());

app.post('/swgoh/data', async (req, res, next) => {
  try {
    res.status(200).json(await helpFormatter.getGameData(req.body));
  } catch(error) {
    next(error);
  }
});

app.post('/swgoh/events', async (req, res, next) => {
  try {
    res.status(200).json(await helpFormatter.getEvents(req.body));
  } catch(error) {
    next(error);
  }
});

app.post('/swgoh/battles', async (req, res, next) => {
  try {
    res.status(200).json(await helpFormatter.getGameData({
      ...req.body,
      collection: 'campaign'
    }));
  } catch(error) {
    next(error);
  }
});

app.post('/swgoh/players', async (req, res, next) => {
  try {
    res.status(200).json(await helpFormatter.getPlayer(req.body));
  } catch(error) {
    next(error);
  }
});

app.post('/swgoh/guilds', async (req, res, next) => {
  try {
    res.status(200).json(await helpFormatter.getGuild(req.body));
  } catch(error) {
    next(error);
  }
});

app.post('/update', async (req, res, next) => {
  try {
    const force = true;
    console.log(`Received request to force update...`);
    res.status(200).json(await helpFormatter.updateCheck(null, null, force));
    console.log(`Forced update complete`);
  } catch(error) {
    next(error);
  }
});

app.use((req, res, next) => {
  res.status(404).json({
    "message": 'Route not found'
  });
});

const ERROR_MAP = {
  2: {
    code: 400,
    error: "Error"
  },
  3: {
    code: 400,
    error: "Server Error"
  },
  7: {
    code: 400,
    error: "Server Unavailable"
  },
  13: {
    code: 400,
    error: "Server Outage"
  },
  20: {
    code: 400,
    error: "Network Unavailable"
  },
  32: {
    code: 404,
    error: "Could not find any players affiliated with these allycodes"
  },
  33: {
    code: 404,
    error: "Event not found"
  }
};

app.use((error, req, res, next) => {
  let responseCode = 400;
  const response = {
    code: responseCode,
    error: error.name,
    error_description: error.message
  };
  if (error && error.response && error.response.body) {
    response.error = error.response.body.message;
    response.error_description = error.response.body.message;
    if (error.response.body.code && ERROR_MAP[error.response.body.code]) {
      let errorDetails = ERROR_MAP[error.response.body.code];
      responseCode = errorDetails.code;
      response.code = responseCode;
      response.error_description = errorDetails.error;
    }
  } else if(error instanceof HelpFormatter.NotInGuildError) {
    responseCode = 404;
    response.code = 404;
    response.error_description = 'Could not find any guilds affiliated with these allycodes';
  }

  res.status(responseCode).json(response);
});

module.exports = app;
module.exports.initHelpFormatter = async() => {

  await initTokens().catch((error) => {
    console.warn(`Error initializing tokens, ignoring: ${error.message}`);
  });
  await helpFormatter.init().catch((error) => {
    console.warn(`Error initializing help formatter, ignoring: ${error.message}`);
  });
};

module.exports.listenForUpdates = async () => {
  try {
    await helpFormatter.listenForUpdates();
  } catch(error) {
    throw(error);
  }
};