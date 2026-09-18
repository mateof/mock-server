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
  // La barra es compartida: sirve para marcar en qué pantalla estamos
  res.render('logs', { title: 'Mock Server - Logs', version, paginaActual: 'logs' });
});

/* Documentación de la API, con Swagger UI */
router.get('/api-docs', function(req, res, next) {
  // La barra es compartida: sirve para marcar en qué pantalla estamos
  res.render('api-docs', { title: 'Mock Server - API', version, paginaActual: 'api-docs' });
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
