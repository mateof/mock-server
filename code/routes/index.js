var express = require('express');
var router = express.Router();
const semaphore = require('../services/semaphore.service');
const config = require('../services/config');
const { version } = require('../package.json');

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Mock Server', listaEspera: semaphore.getList(), wsport: config.getConfig().wsport, version });
});

router.post('/', function(req, res, next) {
  res.render('index', { title: 'Mock Server', listaEspera: semaphore.getList(), wsport: config.getConfig().wsport, version });
});

module.exports = router;
