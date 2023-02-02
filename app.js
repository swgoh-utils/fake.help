const port = process.env.PORT || 3333;
const expressServer = require('./src/expressServer');
let updateListenerRegistered = false;

const { version } = require('./package.json');

const init = async () => {
  try {
    await expressServer.initHelpFormatter();
  } catch(error) {
    console.log(`Encountered an issue initializing the fake.help: ${error.message}`);
    try {
      updateListenerRegistered = true;
      await expressServer.listenForUpdates();
    } catch(e) {
      console.error(`Unable to initialize fake.help: ${e.message}`);
      throw(error);
    }
  }

  // listen for requests :)
  const listener = expressServer.listen(port, () => {
    console.log(`fake.help:${version} is listening on port ${listener.address().port}`);
  });

  if (!updateListenerRegistered) {
    try {
      await expressServer.listenForUpdates();
    } catch(error) {
      console.warn(`Unable to check for updates for fake.help on startup: ${error.message}`);
    }
  }
};
init().catch((error) => {
  console.error(`Error initializing fake.help:`);
  console.error(error);
  process.exit(1);
});