#!/bin/bash

# ============================================
# Mock Server - Script de Inicio
# ============================================

set -e

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Directorio del proyecto (donde está este script)
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}       Mock Server - Iniciando...          ${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# Cambiar al directorio del proyecto
cd "$PROJECT_DIR"

# --------------------------------------------
# 1. Verificar Node.js
# --------------------------------------------
echo -e "${YELLOW}[1/4]${NC} Verificando Node.js..."

if ! command -v node &> /dev/null; then
    echo -e "${RED}ERROR: Node.js no está instalado${NC}"
    echo "Por favor, instala Node.js desde https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v)
echo -e "      Node.js encontrado: ${GREEN}$NODE_VERSION${NC}"

# Verificar versión mínima (v14+)
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'.' -f1 | sed 's/v//')
if [ "$NODE_MAJOR" -lt 14 ]; then
    echo -e "${RED}ERROR: Se requiere Node.js v14 o superior${NC}"
    exit 1
fi

# --------------------------------------------
# 2. Verificar npm
# --------------------------------------------
echo -e "${YELLOW}[2/4]${NC} Verificando npm..."

if ! command -v npm &> /dev/null; then
    echo -e "${RED}ERROR: npm no está instalado${NC}"
    exit 1
fi

NPM_VERSION=$(npm -v)
echo -e "      npm encontrado: ${GREEN}v$NPM_VERSION${NC}"

# --------------------------------------------
# 3. Verificar e instalar dependencias
# --------------------------------------------
echo -e "${YELLOW}[3/4]${NC} Verificando dependencias..."

if [ ! -d "node_modules" ]; then
    echo -e "      ${YELLOW}node_modules no encontrado, instalando dependencias...${NC}"
    npm install
    echo -e "      ${GREEN}Dependencias instaladas correctamente${NC}"
elif [ "package.json" -nt "node_modules" ]; then
    echo -e "      ${YELLOW}package.json modificado, actualizando dependencias...${NC}"
    npm install
    echo -e "      ${GREEN}Dependencias actualizadas correctamente${NC}"
else
    echo -e "      ${GREEN}Dependencias ya instaladas${NC}"
fi

# --------------------------------------------
# 4. Verificar directorio de datos
# --------------------------------------------
echo -e "${YELLOW}[4/4]${NC} Verificando directorio de datos..."

if [ ! -d "data" ]; then
    echo -e "      ${YELLOW}Creando directorio data/...${NC}"
    mkdir -p data
    echo -e "      ${GREEN}Directorio creado${NC}"
else
    echo -e "      ${GREEN}Directorio data/ existe${NC}"
fi

# --------------------------------------------
# Iniciar servidor
# --------------------------------------------
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}       Iniciando Mock Server...            ${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

# Detectar si es desarrollo (nodemon disponible)
if [ "$1" == "--dev" ] || [ "$1" == "-d" ]; then
    if [ -f "node_modules/.bin/nodemon" ]; then
        echo -e "${BLUE}Modo desarrollo (nodemon)${NC}"
        echo ""
        npm run start:local
    else
        echo -e "${YELLOW}nodemon no encontrado, usando node${NC}"
        echo ""
        node app.js
    fi
else
    node app.js
fi
