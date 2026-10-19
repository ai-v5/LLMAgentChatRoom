/**
 * Compile author-facing tool definitions to the raw JSON Schema that
 * `ctx.tools.register` validates. The author DSL keeps requiredness next to a
 * property (`required: true`); raw JSON Schema keeps it in the containing
 * object's `required` array.
 * @module @llmagentchatroom/dsh-plugin/define-tool
 */

/**
 * Keys copied verbatim from an author node; `properties` and `items` are
 * compiled recursively by {@link compileValueSchema}.
 */
const VERBATIM_KEYS = new Set([
  'type',
  'description',
  'title',
  'default',
  'examples',
  'enum',
  'const',
  'additionalProperties',
])

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function requireValueSchema(value, path) {
  if (!isPlainObject(value)) throw new TypeError(`${path} must be a value schema object`)
  return value
}

/**
 * Compile an author value schema node to raw JSON Schema, recursing into
 * `properties` and `items`. A node-level `required` marker is never copied.
 * @param {unknown} input
 * @param {string} [path]
 * @returns {Record<string, unknown>} Raw JSON Schema node.
 */
function compileValueSchema(input, path = 'schema') {
  const source = requireValueSchema(input, path)
  const node = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'required') continue
    if (key === 'properties') {
      const compiled = compilePropertyMap(requireValueSchema(value, `${path}.properties`), `${path}.properties`)
      node.properties = compiled.properties
      if (compiled.required.length > 0) node.required = compiled.required
      continue
    }
    if (key === 'items') {
      node.items = compileValueSchema(value, `${path}.items`)
      continue
    }
    if (!VERBATIM_KEYS.has(key)) {
      throw new TypeError(`${path}.${key} is not supported by the tool schema compiler`)
    }
    node[key] = value
  }
  return node
}

/**
 * Compile an implicit property map, moving each property-level
 * `required: true` into the parent `required` array.
 * @param {Record<string, unknown>} input
 * @param {string} path
 * @returns {{ properties: Record<string, object>, required: string[] }}
 */
function compilePropertyMap(input, path) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(input)) {
    requireValueSchema(spec, `${path}.${key}`)
    if (Object.hasOwn(spec, 'required') && spec.required !== true) {
      throw new TypeError(`${path}.${key}.required must be true when present`)
    }
    const { required: _required, ...rest } = spec
    properties[key] = compileValueSchema(rest, `${path}.${key}`)
    if (spec.required === true) required.push(key)
  }
  return { properties, required }
}

/**
 * Compile an implicit parameter property map into an object-rooted raw schema.
 * @param {Record<string, unknown>} parameters - property name to value schema.
 * @returns {{ type: 'object', properties: Record<string, object>, required?: string[] }}
 */
export function parametersToSchema(parameters) {
  if (!isPlainObject(parameters)) throw new TypeError('parameters must be an object of value schemas')
  const { properties, required } = compilePropertyMap(parameters, 'parameters')
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties }
}

/**
 * Compile one tool definition to the shape `ctx.tools.register` validates.
 * @param {Record<string, any>} options - author-facing tool definition.
 * @returns {Record<string, any>} Definition with raw JSON Schema parameters and output schema.
 */
export function defineTool(options) {
  if (!isPlainObject(options)) throw new TypeError('defineTool: options must be an object')
  const output = options.output
  if (!isPlainObject(output) || !Object.hasOwn(output, 'schema')) {
    throw new TypeError(`defineTool(${String(options.name ?? '')}): output.schema is required`)
  }
  return {
    ...options,
    parameters: parametersToSchema(options.parameters),
    output: { ...output, schema: compileValueSchema(output.schema, 'output.schema') },
  }
}
