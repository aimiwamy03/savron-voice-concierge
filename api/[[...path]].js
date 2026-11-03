// Vercel serves this function at /api/*. Rewrites send /call and /twilio/* here.
const { createServer, loadShopConfig, defaultShopId } = require('../server');

const { server } = createServer({ config: loadShopConfig(defaultShopId()) });

module.exports = server;
