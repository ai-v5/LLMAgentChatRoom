import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineTool, parametersToSchema } from '../src/define-tool.js'

test('property-level required becomes the parent required array', () => {
  const schema = parametersToSchema({
    text: { type: 'string', required: true, description: 'Message body.' },
    reply_to: { type: 'string', description: 'Message id this message replies to.' },
  })
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Message body.' },
      reply_to: { type: 'string', description: 'Message id this message replies to.' },
    },
    required: ['text'],
  })
  assert.equal(Object.hasOwn(schema.properties.text, 'required'), false)
})

test('nested properties and items compile recursively', () => {
  const schema = parametersToSchema({
    messages: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
        },
      },
    },
  })
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      messages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
          },
          required: ['id'],
        },
      },
    },
    required: ['messages'],
  })
})

test('a room_join-like parameter map compiles without a required array', () => {
  const schema = parametersToSchema({
    server: { type: 'string', description: 'Room server base URL.' },
    room: { type: 'string', description: 'Room id.' },
    invite: { type: 'string', description: 'Invite code for the room.' },
    name: { type: 'string', description: 'Member name unique within the room.' },
    platform: { type: 'string', description: 'Platform label reported to the room (default dsh).' },
  })
  assert.deepEqual(schema, {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Room server base URL.' },
      room: { type: 'string', description: 'Room id.' },
      invite: { type: 'string', description: 'Invite code for the room.' },
      name: { type: 'string', description: 'Member name unique within the room.' },
      platform: { type: 'string', description: 'Platform label reported to the room (default dsh).' },
    },
  })
  assert.equal(Object.hasOwn(schema, 'required'), false)
})

test('defineTool compiles parameters and the output schema, preserving other options', () => {
  const render = (_args, value) => [{ type: 'text', text: String(value.ok) }]
  const tool = defineTool({
    name: 'room_join',
    description: 'Join a room.',
    parameters: { server: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render,
    },
    async execute() {
      return { ok: true }
    },
  })
  assert.deepEqual(tool.parameters, {
    type: 'object',
    properties: { server: { type: 'string' } },
    required: ['server'],
  })
  assert.deepEqual(tool.output.schema, {
    type: 'object',
    additionalProperties: false,
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  })
  assert.equal(Object.hasOwn(tool.output.schema.properties.ok, 'required'), false)
  assert.equal(tool.output.render, render)
  assert.equal(typeof tool.execute, 'function')
})
