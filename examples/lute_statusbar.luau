-- Run with Lute and the repository's standard @lute/* modules available.
-- Set WORKBENCH_BRIDGE_SESSION or pass --session <descriptor.json>.
-- The default run creates, updates, and disposes the item. Pass --wait to keep
-- it alive and print visibility callbacks. --once is an explicit one-shot alias.
local Json = require('@std/json')
local Fs = require('@std/fs')
local Process = require('@lute/process')
local Task = require('@std/task')
local Time = require('@lute/time')
local Net = require('@lute/net/client')

local function object(fields)
  return Json.object(fields)
end

local sessionPath = Process.env.WORKBENCH_BRIDGE_SESSION
local once = true
local i = 1
while i <= #Process.args do
  if Process.args[i] == '--once' then
    once = true
  elseif Process.args[i] == '--wait' then
    once = false
  elseif Process.args[i] == '--session' then
    i += 1
    sessionPath = Process.args[i]
  elseif not sessionPath and string.sub(Process.args[i], 1, 1) ~= '-' then
    sessionPath = Process.args[i]
  end
  i += 1
end
assert(sessionPath, 'Set WORKBENCH_BRIDGE_SESSION or pass --session <descriptor.json>')
local descriptor = Json.deserialize(Fs.readFileToString(sessionPath))

local incoming = {}
local opened = false
local socketError = nil
local callbacks = {}
local nextId = 0
local socket
local function send(message)
  socket:send(Json.serialize(message))
end

socket = Net.websocket(descriptor.endpoint, {
  onopen = function() opened = true end,
  onmessage = function(raw)
    local text = if type(raw) == 'buffer' then buffer.readstring(raw, 0, buffer.len(raw)) else raw
    table.insert(incoming, Json.deserialize(text))
  end,
  onerror = function(error) socketError = error end,
  onclose = function(code, reason) socketError = `WebSocket closed ({code}): {reason}` end,
})

local function wireEncode(value)
  if value == nil then return object({ ['$type'] = 'undefined' }) end
  if type(value) == 'table' then
    if #value > 0 then
      local items = {}
      for _, item in ipairs(value) do table.insert(items, wireEncode(item)) end
      return object({ ['$type'] = 'array', items = items })
    end
    local entries = {}
    for key, item in pairs(value) do table.insert(entries, { key, wireEncode(item) }) end
    return object({ ['$type'] = 'object', entries = entries })
  end
  return value
end

local function wireDecode(value)
  if type(value) ~= 'table' then return value end
  if value['$type'] == 'undefined' then return nil end
  if value['$type'] == 'ref' then return value end
  if value['$type'] == 'array' then
    local result = {}
    for _, item in value.items do table.insert(result, wireDecode(item)) end
    return result
  end
  if value['$type'] == 'object' then
    local result = {}
    for _, entry in value.entries do result[entry[1]] = wireDecode(entry[2]) end
    return result
  end
  return value
end

local function answerCallback(message)
  local params = message.params
  local callback = callbacks[tostring(params.id)]
  local result = object({ ['$type'] = 'undefined' })
  if callback then
    local args = {}
    for _, arg in params.args do table.insert(args, wireDecode(arg)) end
    result = wireEncode(callback(table.unpack(args)))
  end
  send(object({ jsonrpc = '2.0', id = message.id, result = result }))
end

local function rpc(method, params)
  nextId += 1
  local id = nextId
  local startedAt = Time.now()
  send(object({ jsonrpc = '2.0', id = id, method = method, params = params }))
  while true do
    if socketError then error(socketError) end
    if Time.since(startedAt) > 15 then error(`RPC timed out: {method}`) end
    if #incoming > 0 then
      local message = table.remove(incoming, 1)
      if message.method == 'callback' and message.id ~= nil then
        answerCallback(message)
      elseif message.id == id then
        if message.error then error(message.error.message or 'RPC failed') end
        return message.result
      end
    else
      Task.wait(0.01)
    end
  end
end

local function run()
  local openStarted = Time.now()
  while not opened do
    if socketError then error(socketError) end
    if Time.since(openStarted) > 15 then error('Timed out opening WebSocket') end
    Task.wait(0.01)
  end
  rpc('connect', object({ token = descriptor.token, workspace = descriptor.workspace }))
  local item = rpc('call', object({
    target = 'vscode', path = { 'window', 'createStatusBarItem' }, args = { 'bridge.external.lute', 1, 100 }, owned = true,
  }))
  rpc('set', object({ target = item, path = { 'text' }, value = '$(check) Connected from Lute' }))

  nextId += 1
  local callbackId = tostring(nextId)
  callbacks[callbackId] = function(document)
    print('Opened document ref: ' .. tostring(document.id))
    return { received = true }
  end
  local subscription = rpc('subscribe', object({
    target = 'vscode', path = { 'workspace', 'onDidOpenTextDocument' },
    callback = object({ ['$type'] = 'callback', id = callbackId }),
  }))
  local documentOptions = object({ ['$type'] = 'object', entries = {
    { 'language', 'plaintext' }, { 'content', 'Opened by the external Lute bridge client' },
  } })
  rpc('call', object({ target = 'vscode', path = { 'workspace', 'openTextDocument' }, args = { documentOptions } }))
  rpc('call', object({ target = item, path = { 'show' }, args = {} }))
  print('Status bar item created; use --wait to keep the client attached.')
  if not once then
    while not socketError do
      if #incoming > 0 then
        local message = table.remove(incoming, 1)
        if message.method == 'callback' and message.id ~= nil then answerCallback(message) end
      else
        Task.wait(0.05)
      end
    end
    error(socketError)
  end
  Task.wait(0.05)
  while #incoming > 0 do
    local message = table.remove(incoming, 1)
    if message.method == 'callback' and message.id ~= nil then answerCallback(message) end
  end
  rpc('unsubscribe', object({ subscription = subscription }))
  callbacks[callbackId] = nil
  rpc('dispose', object({ target = item }))
  print('PASS: status bar item created, workspace event handled, and resources disposed')
end

local ok, err = pcall(run)
if socket then socket:close() end
if not ok then error(err) end
