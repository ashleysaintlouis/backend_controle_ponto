"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.swaggerUiServe = exports.swaggerUiHandler = exports.swaggerSpec = void 0;
const swagger_jsdoc_1 = __importDefault(require("swagger-jsdoc"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Controle de Ponto API',
            version: '1.0.0',
            description: 'API de autenticação e gestão de usuários do sistema de controle de ponto.',
        },
        servers: [
            {
                url: 'http://localhost:3333',
                description: 'Servidor de desenvolvimento',
            },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
        security: [{ bearerAuth: [] }],
    },
    apis: ['./src/**/*.ts'],
};
exports.swaggerSpec = (0, swagger_jsdoc_1.default)(options);
exports.swaggerUiHandler = swagger_ui_express_1.default.setup(exports.swaggerSpec);
exports.swaggerUiServe = swagger_ui_express_1.default.serve;
