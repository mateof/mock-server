
const crypto = require('crypto');

const snooze = ms => new Promise(resolve => setTimeout(resolve, ms));
let waitList;


const init = () => {
    waitList = [];
    // listaEspera.push({id:"asdasd", url:"dsadasd", date:"asdddddd"});
}

const addToListAndWait = async (element) => {
    waitList.push(element);
    while (element.sleep === true)
        await snooze(1000);
    waitList = waitList.filter(ele => ele.id !== element.id);
}

const wakeUp = (id, customResponse = null) => {
    element = findInList(id);
    if (!element)
        return false;
    if (customResponse !== null) {
        element.customResponse = customResponse;
    }
    element.sleep = false;
    return true;
}

function findInList(id) {
    return waitList.find((element) => element.id === id);
}

const getList = () => {
   return waitList ?? [];
}

const generateUUID = () => {
    return crypto.randomUUID();


}


exports.init = init;
exports.addToListAndWait = addToListAndWait;
exports.wakeUp = wakeUp;
exports.getList = getList;
exports.generateUUID = generateUUID;

