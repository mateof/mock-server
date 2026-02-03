#!/usr/bin/env node

// ============================================
// MOCK SERVER - Aplicación Principal
// ============================================

// ===== DEPENDENCIAS =====
const express = require('express');
const path = require('path');
const logger = require('morgan');
const http = require('http');
const expressLayouts = require('express-ejs-layouts');
const cors = require('cors');
const chalk = require('chalk');

// ===== SERVICIOS =====
const sqliteService = require('./services/sqlite.service');
const socketService = require('./services/socket.service');
const semaphore = require('./services/semaphore.service');

// ===== MIDDLEWARES =====
const routesMiddleware = require('./middlewares/routes.middleware');
const proxyMiddleware = require('./middlewares/proxy.middleware');

// ===== RUTAS =====
const indexRouter = require('./routes/index');
const apiRouter = require('./routes/api');

// ============================================
// CONFIGURACIÓN
// ============================================

console.log('[APP] ==========================================');
console.log('[APP]        MOCK SERVER - INICIANDO           ');
console.log('[APP] ==========================================');

const app = express();
const port = process.env.PORT || 3880;
const server = http.createServer(app);

// ============================================
// INICIALIZACIÓN DE SERVICIOS
// ============================================

console.log('[APP] Inicializando servicios...');
socketService.init(server);
semaphore.init();
console.log('[APP] Servicios inicializados');

// ============================================
// CONFIGURACIÓN DE EXPRESS
// ============================================

// Motor de vistas
app.set('views', path.join(__dirname, 'views'));
app.set('layout', './layout/layout');
app.set('view engine', 'ejs');

// Variables globales para vistas
app.locals.version = require('./package.json').version;

// Middlewares
app.use(cors({ credentials: true, origin: '*' }));
app.use(expressLayouts);
app.use(logger('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

console.log('[APP] Express configurado');

// ============================================
// RUTAS
// ============================================

app.use('/', indexRouter);
app.use('/api', apiRouter);

console.log('[APP] Rutas registradas');

// ============================================
// MIDDLEWARE DE RUTAS MOCK
// ============================================

app.use(routesMiddleware.checkRoute);

// ============================================
// MIDDLEWARE DE PROXY (placeholder)
// Se configura después de inicializar la BD
// ============================================

// Middleware de proxy que se activa después de la inicialización
let proxyHandler = null;
app.use((req, res, next) => {
  if (proxyHandler) {
    return proxyHandler(req, res, next);
  }
  next();
});

// Función para establecer el handler de proxy
app.setProxyHandler = (handler) => {
  proxyHandler = handler;
};

// ============================================
// MANEJO DE ERRORES
// ============================================

// 404 handler
app.use(function (req, res, next) {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// Error handler
app.use(function (err, req, res, next) {
  console.error(`[APP] ERROR: ${err.message}`);

  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  res.locals.version = require('./package.json').version;

  res.status(err.status || 500);
  res.render('error');
});

// ============================================
// INICIO DEL SERVIDOR
// ============================================

server.listen(port);

server.on('error', (error) => {
  if (error.syscall !== 'listen') {
    throw error;
  }

  const bind = typeof port === 'string' ? 'Pipe ' + port : 'Port ' + port;

  switch (error.code) {
    case 'EACCES':
      console.error(`[APP] ERROR: ${bind} requiere privilegios elevados`);
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(`[APP] ERROR: ${bind} ya está en uso`);
      process.exit(1);
      break;
    default:
      throw error;
  }
});

server.on('listening', () => {
  const addr = server.address();
  const url = `http://localhost:${addr.port}`;

  console.log('[APP] ==========================================');
  console.log(`[APP]   Servidor escuchando en puerto ${addr.port}`);
  console.log('[APP] ==========================================');
  console.log('');
  console.log(`  ${chalk.bold('Mock Server listo!')}`);
  console.log('');
  console.log(`  ${chalk.dim('→')} Local:   ${chalk.cyan.underline(url)}`);
  console.log('');
});

// ============================================
// INICIALIZACIÓN ASÍNCRONA
// ============================================

(async () => {
  console.log('[APP] Inicializando base de datos...');
  await sqliteService.initSql();
  console.log('[APP] Base de datos inicializada');

  console.log('[APP] Configurando proxy...');
  await proxyMiddleware.configureProxy(app);

  console.log('[APP] ==========================================');
  console.log('[APP]      MOCK SERVER LISTO PARA USAR         ');
  console.log('[APP] ==========================================');
})();

// ============================================
// EXPORTS
// ============================================

module.exports = app;
