const { Server } = require('socket.io');
const moment = require("moment");

let io;

// ===== TIPOS DE LOG =====
const LogType = {
    INFO: 'info',
    SUCCESS: 'success',
    WARNING: 'warning',
    ERROR: 'error',
    PROXY: 'proxy',
    PROXY_DETAILED: 'proxy-detailed',
    MOCK: 'mock',
    REDIRECT: 'redirect',
    EMPTY: 'empty',
    PAGE: 'page',
    WAIT: 'wait'
};

// ===== INICIALIZACIÓN =====
const init = (server) => {
    // Usar el mismo servidor HTTP de Express
    io = new Server(server, {
        cors: {
          origin: "*"
        }
      });
    io.on('connection', (socket) => {
        console.log('Un usuario se ha conectado');
        log.success('Conectado al servidor');
        socket.on('disconnect', () => {
            console.log('Usuario desconectado');
        });
        // Handler para medir latencia
        socket.on('ping', (callback) => {
            if (typeof callback === 'function') callback();
        });
    });
};

// ===== FUNCIONES DE EMISIÓN =====
const sendData = (route, data) => {
    io.emit(route, data);
};

const getTimestamp = () => moment().format("HH:mm:ss.SSS");

const emitLog = (texto, type = LogType.INFO) => {
    io.emit("console", {
        texto: `[${getTimestamp()}] ${texto}`,
        type: type
    });
};

// ===== API DE LOGGING =====
const log = {
    // Logs básicos
    info: (msg) => emitLog(msg, LogType.INFO),
    success: (msg) => emitLog(msg, LogType.SUCCESS),
    warning: (msg) => emitLog(msg, LogType.WARNING),
    error: (msg) => emitLog(msg, LogType.ERROR),

    // Logs de request con formato estructurado
    request: (method, url, statusCode, duration, type = LogType.INFO) => {
        const icon = getIconForType(type);
        emitLog(`${icon} ${method} ${url} ${statusCode} ${duration}ms`, type);
    },

    // Logs específicos por tipo de respuesta
    mock: (method, url, statusCode, duration) => {
        log.request(method, url, statusCode, duration, LogType.MOCK);
    },

    proxy: (method, url, target, statusCode, duration) => {
        emitLog(`🔀 ${method} ${url} → ${target} ${statusCode} ${duration}ms`, LogType.PROXY);
    },

    proxyDetailed: (data) => {
        // Envía log detallado con información colapsable
        io.emit("console", {
            texto: `[${getTimestamp()}] 🔀 ${data.method} ${data.url} → ${data.target} ${data.statusCode} ${data.duration}ms`,
            type: LogType.PROXY_DETAILED,
            collapsible: true,
            details: {
                request: {
                    method: data.method,
                    url: data.url,
                    target: data.targetFull,
                    headers: data.requestHeaders,
                    body: data.requestBody
                },
                response: {
                    statusCode: data.statusCode,
                    headers: data.responseHeaders,
                    body: data.responseBody
                }
            }
        });
    },

    proxyError: (method, url, target, errorMsg) => {
        emitLog(`❌ Proxy error: ${method} ${url} → ${target} - ${errorMsg}`, LogType.ERROR);
    },

    redirect: (method, url, statusCode, duration) => {
        log.request(method, url, statusCode, duration, LogType.REDIRECT);
    },

    page: (method, url, statusCode, duration) => {
        log.request(method, url, statusCode, duration, LogType.PAGE);
    },

    empty: (method, url, statusCode, duration) => {
        log.request(method, url, statusCode, duration, LogType.EMPTY);
    },

    wait: (method, url) => {
        emitLog(`⏸️ Espera activa: ${method} ${url}`, LogType.WAIT);
    },

    notConfigured: (method, url, statusCode, duration) => {
        emitLog(`🔶 ${method} ${url} ${statusCode} ${duration}ms (sin configurar)`, LogType.WARNING);
    }
};

// ===== HELPERS =====
const getIconForType = (type) => {
    const icons = {
        [LogType.SUCCESS]: '✅',
        [LogType.MOCK]: '✅',
        [LogType.ERROR]: '❌',
        [LogType.WARNING]: '⚠️',
        [LogType.PROXY]: '🔀',
        [LogType.REDIRECT]: '↪️',
        [LogType.PAGE]: '📄',
        [LogType.EMPTY]: '⭕',
        [LogType.WAIT]: '⏸️',
        [LogType.INFO]: 'ℹ️'
    };
    return icons[type] || '•';
};

// ===== COMPATIBILIDAD (deprecated, usar log.*) =====
const sendToLog = (data) => {
    if (typeof data === 'object' && data.texto) {
        io.emit("console", {
            texto: `[${getTimestamp()}] ${data.texto}`,
            type: data.color || LogType.INFO
        });
    } else {
        emitLog(String(data), LogType.INFO);
    }
};

exports.init = init;
exports.sendData = sendData;
exports.sendToLog = sendToLog;
exports.log = log;
exports.LogType = LogType;