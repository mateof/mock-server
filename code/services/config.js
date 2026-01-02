global.config = {
    returnError: false
};

const setConfigReturnError = (value) => {
    global.config.returnError = value;
};

const getConfig = () => {
    return global.config;
}

exports.setConfigReturnError = setConfigReturnError;
exports.getConfig = getConfig;