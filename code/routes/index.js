var express = require('express');
var router = express.Router();
const semaphore = require('../services/semaphore.service');
const { version } = require('../package.json');
const i18n = require('i18n');

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Mock Server', listaEspera: semaphore.getList(), version });
});

router.post('/', function(req, res, next) {
  res.render('index', { title: 'Mock Server', listaEspera: semaphore.getList(), version });
});

/* Pantalla de logs */
router.get('/logs', function(req, res, next) {
  res.render('logs', { title: 'Mock Server - Logs', version });
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
