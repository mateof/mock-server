var express = require('express');
var router = express.Router();
const semaphore = require('../services/semaphore.service');
const config = require('../services/config');
const { version } = require('../package.json');
const i18n = require('i18n');

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Mock Server', listaEspera: semaphore.getList(), wsport: config.getConfig().wsport, version });
});

router.post('/', function(req, res, next) {
  res.render('index', { title: 'Mock Server', listaEspera: semaphore.getList(), wsport: config.getConfig().wsport, version });
});

/* Cambio de idioma */
router.get('/lang/:locale', function(req, res) {
  const locale = req.params.locale;
  if (i18n.getLocales().includes(locale)) {
    res.cookie('mock-server-lang', locale, { maxAge: 365 * 24 * 60 * 60 * 1000 });
    res.setLocale(locale);
  }
  res.redirect('back');
});

module.exports = router;
