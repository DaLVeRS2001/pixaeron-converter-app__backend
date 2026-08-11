import * as Joi from 'joi';

export const booleanValue = Joi.string().valid('true', 'false').required();

export const nodeEnvironment = Joi.string()
  .valid('development', 'test', 'production')
  .required();

export const port = Joi.number().port().required().raw();

export const postgresUrl = Joi.string()
  .uri({ scheme: ['postgres', 'postgresql'] })
  .required();
