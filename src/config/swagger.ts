import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Controle de Ponto API',
      version: '1.0.0',
      description:
        'API de autenticação e gestão de usuários do sistema de controle de ponto.',
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

export const swaggerSpec = swaggerJsdoc(options);
export const swaggerUiHandler = swaggerUi.setup(swaggerSpec);
export const swaggerUiServe = swaggerUi.serve;
