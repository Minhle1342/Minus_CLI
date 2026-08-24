type JsonSchema = Record<string, any>;

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

function normalizedType(schema: JsonSchema): string | undefined {
  const type = schema?.type;
  return typeof type === 'string' ? type.toLowerCase() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the JSON-schema subset used by Gemini/OpenAI function declarations. */
export function validateSchemaValue(
  value: unknown,
  schema: JsonSchema | undefined,
  path = '$',
  options: { rejectUnknownProperties?: boolean } = {},
): SchemaValidationResult {
  if (!schema) return { valid: true, errors: [] };
  const errors: string[] = [];
  const type = normalizedType(schema);

  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.some((candidate: unknown) => Object.is(candidate, value))) {
    errors.push(`${path} must be one of: ${schema.enum.map((item: unknown) => JSON.stringify(item)).join(', ')}`);
    return { valid: false, errors };
  }

  if (value === null) {
    if (!schema.nullable && type !== 'null') errors.push(`${path} must not be null`);
    return { valid: errors.length === 0, errors };
  }

  switch (type) {
    case 'object': {
      if (!isPlainObject(value)) {
        errors.push(`${path} must be an object`);
        break;
      }
      const properties = (schema.properties || {}) as Record<string, JsonSchema>;
      for (const required of schema.required || []) {
        if (!Object.prototype.hasOwnProperty.call(value, required)) {
          errors.push(`${path}.${required} is required`);
        }
      }
      for (const [key, child] of Object.entries(value)) {
        const propertySchema = properties[key];
        if (!propertySchema) {
          if (schema.additionalProperties === false || options.rejectUnknownProperties) {
            errors.push(`${path}.${key} is not declared by the tool schema`);
          }
          continue;
        }
        errors.push(...validateSchemaValue(child, propertySchema, `${path}.${key}`, options).errors);
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`);
      } else {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
          errors.push(`${path} must contain at least ${schema.minItems} item(s)`);
        }
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
          errors.push(`${path} must contain at most ${schema.maxItems} item(s)`);
        }
        value.forEach((item, index) => {
          errors.push(...validateSchemaValue(item, schema.items, `${path}[${index}]`, options).errors);
        });
      }
      break;
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} must be a string`);
      else {
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path} is too short`);
        if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path} is too long`);
        if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${path} does not match the required pattern`);
      }
      break;
    case 'integer':
      if (!Number.isInteger(value)) errors.push(`${path} must be an integer`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path} must be a finite number`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
      break;
    case undefined:
      break;
    default:
      errors.push(`${path} uses unsupported schema type ${type}`);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }

  return { valid: errors.length === 0, errors };
}

/** JSON snapshots are the only values allowed to cross the durable tool boundary. */
export function cloneJsonStrict<T>(
  value: T,
  label: string,
  options: { omitUndefinedObjectProperties?: boolean } = {},
): T {
  const seen = new Set<object>();
  const visit = (item: unknown, path: string): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error(`${label} contains a non-finite number at ${path}`);
      return;
    }
    if (typeof item !== 'object') throw new Error(`${label} contains a non-JSON value at ${path}`);
    if (seen.has(item as object)) throw new Error(`${label} contains a circular reference at ${path}`);
    seen.add(item as object);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(item, index)) {
          throw new Error(`${label} contains a sparse array entry at ${path}[${index}]`);
        }
        visit(item[index], `${path}[${index}]`);
      }
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${label} contains a non-plain object at ${path}`);
      }
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        if (child === undefined && options.omitUndefinedObjectProperties) continue;
        visit(child, `${path}.${key}`);
      }
    }
    seen.delete(item as object);
  };
  visit(value, '$');
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
