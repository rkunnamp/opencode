import z from "zod"
import { App } from "../app/app"
import { Config } from "../config/config"
import { mergeDeep, sortBy } from "remeda"
import { NoSuchModelError, type LanguageModel, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { BunProc } from "../bun"
import { BashTool } from "../tool/bash"
import { EditTool } from "../tool/edit"
import { WebFetchTool } from "../tool/webfetch"
import { GlobTool } from "../tool/glob"
import { GrepTool } from "../tool/grep"
import { ListTool } from "../tool/ls"
import { PatchTool } from "../tool/patch"
import { ReadTool } from "../tool/read"
import type { Tool } from "../tool/tool"
import { WriteTool } from "../tool/write"
import { TodoReadTool, TodoWriteTool } from "../tool/todo"
import { TaskTool } from "../tool/task"
import { AgentTool } from "../tool/agent"
import { AuthAnthropic } from "../auth/anthropic"
import { AuthCopilot } from "../auth/copilot"
import { ModelsDev } from "./models"
import { Auth } from "../auth"
import * as ProviderErrors from "./errors"

export namespace Provider {
  const log = Log.create({ service: "provider" })
  
  // Debug logging toggle - set to false to disable debug logging
  const DEBUG_LOGGING = false

  type CustomLoader = (
    provider: ModelsDev.Provider,
    api?: string,
  ) => Promise<{
    autoload: boolean
    getModel?: (sdk: any, modelID: string) => Promise<any>
    options?: Record<string, any>
  }>

  type Source = "env" | "config" | "custom" | "api"

  const CUSTOM_LOADERS: Record<string, CustomLoader> = {
    async anthropic(provider) {
      const access = await AuthAnthropic.access()
      if (!access) return { autoload: false }
      for (const model of Object.values(provider.models)) {
        model.cost = {
          input: 0,
          output: 0,
        }
      }
      return {
        autoload: true,
        options: {
          apiKey: "",
          async fetch(input: any, init: any) {
            const access = await AuthAnthropic.access()
            const headers = {
              ...init.headers,
              authorization: `Bearer ${access}`,
              "anthropic-beta": "oauth-2025-04-20",
            }
            delete headers["x-api-key"]
            return fetch(input, {
              ...init,
              headers,
            })
          },
        },
      }
    },
    "github-copilot": async (provider) => {
      const copilot = await AuthCopilot()
      if (!copilot) return { autoload: false }
      let info = await Auth.get("github-copilot")
      if (!info || info.type !== "oauth") return { autoload: false }

      if (provider && provider.models) {
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
          }
        }
      }

      return {
        autoload: true,
        options: {
          apiKey: "",
          async fetch(input: any, init: any) {
            const info = await Auth.get("github-copilot")
            if (!info || info.type !== "oauth") return
            if (!info.access || info.expires < Date.now()) {
              const tokens = await copilot.access(info.refresh)
              if (!tokens)
                throw new Error("GitHub Copilot authentication expired")
              await Auth.set("github-copilot", {
                type: "oauth",
                ...tokens,
              })
              info.access = tokens.access
            }
            let isAgentCall = false
            try {
              const body =
                typeof init.body === "string"
                  ? JSON.parse(init.body)
                  : init.body
              if (body?.messages) {
                isAgentCall = body.messages.some(
                  (msg: any) =>
                    msg.role && ["tool", "assistant"].includes(msg.role),
                )
              }
            } catch {}
            const headers = {
              ...init.headers,
              ...copilot.HEADERS,
              Authorization: `Bearer ${info.access}`,
              "Openai-Intent": "conversation-edits",
              "X-Initiator": isAgentCall ? "agent" : "user",
            }
            delete headers["x-api-key"]
            return fetch(input, {
              ...init,
              headers,
            })
          },
        },
      }
    },
    openai: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string) {
          return sdk.responses(modelID)
        },
        options: {},
      }
    },
    "amazon-bedrock": async () => {
      if (!process.env["AWS_PROFILE"] && !process.env["AWS_ACCESS_KEY_ID"])
        return { autoload: false }

      const region = process.env["AWS_REGION"] ?? "us-east-1"

      const { fromNodeProviderChain } = await import(
        await BunProc.install("@aws-sdk/credential-providers")
      )
      return {
        autoload: true,
        options: {
          region,
          credentialProvider: fromNodeProviderChain(),
        },
        async getModel(sdk: any, modelID: string) {
          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = ["claude", "deepseek"].some((m) =>
                modelID.includes(m),
              )
              if (modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = [
                "claude",
                "nova-lite",
                "nova-micro",
                "llama3",
                "pixtral",
              ].some((m) => modelID.includes(m))
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const modelRequiresPrefix = [
                "claude",
                "nova-lite",
                "nova-micro",
                "nova-pro",
              ].some((m) => modelID.includes(m))
              if (modelRequiresPrefix) {
                regionPrefix = "apac"
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    },
    openrouter: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
          },
        },
      }
    },
  }

  const state = App.state("provider", async () => {
    const config = await Config.get()
    const database = await ModelsDev.get()

    const providers: {
      [providerID: string]: {
        source: Source
        info: ModelsDev.Provider
        getModel?: (sdk: any, modelID: string) => Promise<any>
        options: Record<string, any>
      }
    } = {}
    const models = new Map<
      string,
      { info: ModelsDev.Model; language: LanguageModel }
    >()
    const sdk = new Map<string, SDK>()

    log.info("init")

    function mergeProvider(
      id: string,
      options: Record<string, any>,
      source: Source,
      getModel?: (sdk: any, modelID: string) => Promise<any>,
    ) {
      const provider = providers[id]
      if (!provider) {
        const info = database[id]
        if (!info) return
        if (info.api) options["baseURL"] = info.api
        providers[id] = {
          source,
          info,
          options,
          getModel,
        }
        return
      }
      provider.options = mergeDeep(provider.options, options)
      provider.source = source
      provider.getModel = getModel ?? provider.getModel
    }

    const configProviders = Object.entries(config.provider ?? {})

    for (const [providerID, provider] of configProviders) {
      const existing = database[providerID]
      const parsed: ModelsDev.Provider = {
        id: providerID,
        npm: provider.npm ?? existing?.npm,
        name: provider.name ?? existing?.name ?? providerID,
        env: provider.env ?? existing?.env ?? [],
        api: provider.api ?? existing?.api,
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const existing = parsed.models[modelID]
        const parsedModel: ModelsDev.Model = {
          id: modelID,
          name: model.name ?? existing?.name ?? modelID,
          release_date: model.release_date ?? existing?.release_date,
          attachment: model.attachment ?? existing?.attachment ?? false,
          reasoning: model.reasoning ?? existing?.reasoning ?? false,
          temperature: model.temperature ?? existing?.temperature ?? false,
          tool_call: model.tool_call ?? existing?.tool_call ?? true,
          cost: {
            ...existing?.cost,
            ...model.cost,
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
          },
          options: {
            ...existing?.options,
            ...model.options,
          },
          limit: model.limit ??
            existing?.limit ?? {
              context: 0,
              output: 0,
            },
        }
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }

    const disabled = await Config.get().then(
      (cfg) => new Set(cfg.disabled_providers ?? []),
    )
    // load env
    for (const [providerID, provider] of Object.entries(database)) {
      if (disabled.has(providerID)) continue
      const apiKey = provider.env.map((item) => process.env[item]).at(0)
      if (!apiKey) continue
      mergeProvider(
        providerID,
        // only include apiKey if there's only one potential option
        provider.env.length === 1 ? { apiKey } : {},
        "env",
      )
    }

    // load apikeys
    for (const [providerID, provider] of Object.entries(await Auth.all())) {
      if (disabled.has(providerID)) continue
      if (provider.type === "api") {
        mergeProvider(providerID, { apiKey: provider.key }, "api")
      }
    }

    // load custom
    for (const [providerID, fn] of Object.entries(CUSTOM_LOADERS)) {
      if (disabled.has(providerID)) continue
      const result = await fn(database[providerID])
      if (result && (result.autoload || providers[providerID])) {
        mergeProvider(
          providerID,
          result.options ?? {},
          "custom",
          result.getModel,
        )
      }
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      mergeProvider(providerID, provider.options ?? {}, "config")
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      if (Object.keys(provider.info.models).length === 0) {
        delete providers[providerID]
        continue
      }
      log.info("found", { providerID })
    }

    return {
      models,
      providers,
      sdk,
    }
  })

  export async function list() {
    return state().then((state) => state.providers)
  }

  async function getSDK(provider: ModelsDev.Provider) {
    return (async () => {
      using _ = log.time("getSDK", {
        providerID: provider.id,
      })

      // Debug: Log provider info
      const debugLog = (msg: string, data?: any) => {
        if (!DEBUG_LOGGING) return
        const logEntry = `[${new Date().toISOString()}] getSDK(${provider.id}): ${msg}${data ? " " + JSON.stringify(data) : ""}\n`
        try {
          require("fs").appendFileSync("/tmp/opencode-debug.log", logEntry)
        } catch (e) {
          console.error("Failed to write debug log:", e)
        }
      }

      debugLog("Starting SDK initialization", {
        providerId: provider.id,
        npm: provider.npm,
      })

      const s = await state()
      const existing = s.sdk.get(provider.id)
      if (existing) {
        debugLog("Found existing SDK, returning cached version")
        return existing
      }

      const pkg = provider.npm ?? provider.id
      debugLog("Package to install/import", { pkg })

      let mod: any
      try {
        debugLog("Trying BunProc.install first")
        const installPath = await BunProc.install(pkg, "latest")
        debugLog("BunProc.install successful", { installPath })

        try {
          debugLog("Trying import from install path")
          mod = await import(installPath)
          debugLog("Import from install path successful", {
            moduleKeys: Object.keys(mod),
          })
        } catch (pathError) {
          debugLog("Import from install path failed, trying package name", {
            pathError: (pathError as Error).message,
          })
          mod = await import(pkg)
          debugLog("Import from package name successful", {
            moduleKeys: Object.keys(mod),
          })
        }
      } catch (installError) {
        debugLog("BunProc.install failed, trying package name directly", {
          installError: (installError as Error).message,
        })
        try {
          mod = await import(pkg)
          debugLog("Direct package name import successful", {
            moduleKeys: Object.keys(mod),
          })
        } catch (pkgError) {
          debugLog("All import methods failed", {
            installError: (installError as Error).message,
            pkgError: (pkgError as Error).message,
          })
          throw pkgError
        }
      }

      const availableKeys = Object.keys(mod)
      const createFunctionKey = availableKeys.find((key) =>
        key.startsWith("create"),
      )
      debugLog("Looking for create function", {
        availableKeys,
        foundKey: createFunctionKey,
      })

      if (!createFunctionKey) {
        debugLog("No create function found")
        throw new Error(
          `No function starting with 'create' found in module. Available functions: ${availableKeys.join(", ")}`,
        )
      }

      const fn = mod[createFunctionKey]
      const providerOptions = s.providers[provider.id]?.options
      debugLog("Calling create function", {
        functionName: createFunctionKey,
        options: providerOptions,
        fnType: typeof fn,
      })

      let loaded: any
      try {
        loaded = fn(providerOptions)
        debugLog("SDK creation successful", { loadedType: typeof loaded })
      } catch (e) {
        debugLog("SDK creation failed", { error: (e as Error).message, stack: (e as Error).stack })
        throw e
      }

      s.sdk.set(provider.id, loaded)
      debugLog("SDK cached and returning")
      return loaded as SDK
    })().catch((e) => {
      const debugLog = (msg: string, data?: any) => {
        if (!DEBUG_LOGGING) return
        const logEntry = `[${new Date().toISOString()}] getSDK(${provider.id}): ${msg}${data ? " " + JSON.stringify(data) : ""}\n`
        try {
          require("fs").appendFileSync("/tmp/opencode-debug.log", logEntry)
        } catch (err) {
          console.error("Failed to write debug log:", err)
        }
      }
      debugLog("getSDK failed, throwing ProviderInitError", {
        error: e.message,
        stack: e.stack,
      })
      throw new InitError({ providerID: provider.id }, { cause: e })
    })
  }

  export async function getModel(providerID: string, modelID: string) {
    const key = `${providerID}/${modelID}`
    const s = await state()
    if (s.models.has(key)) return s.models.get(key)!

    log.info("getModel", {
      providerID,
      modelID,
    })

    const provider = s.providers[providerID]
    if (!provider) throw new ModelNotFoundError({ providerID, modelID })
    const info = provider.info.models[modelID]
    if (!info) throw new ModelNotFoundError({ providerID, modelID })
    const sdk = await getSDK(provider.info)

    try {
      const language = provider.getModel
        ? await provider.getModel(sdk, modelID)
        : sdk.languageModel(modelID)
      log.info("found", { providerID, modelID })
      s.models.set(key, {
        info,
        language,
      })
      return {
        info,
        language,
      }
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: modelID,
            providerID,
          },
          { cause: e },
        )
      throw e
    }
  }

  const priority = ["gemini-2.5-pro-preview", "codex-mini", "claude-sonnet-4"]
  export function sort(models: ModelsDev.Model[]) {
    return sortBy(
      models,
      [
        (model) => priority.findIndex((filter) => model.id.includes(filter)),
        "desc",
      ],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export async function defaultModel() {
    const cfg = await Config.get()
    if (cfg.model) return parseModel(cfg.model)
    const provider = await list()
      .then((val) => Object.values(val))
      .then((x) =>
        x.find(
          (p) => !cfg.provider || Object.keys(cfg.provider).includes(p.info.id),
        ),
      )
    if (!provider) throw new Error("no providers found")
    const [model] = sort(Object.values(provider.info.models))
    if (!model) throw new Error("no models found")
    return {
      providerID: provider.info.id,
      modelID: model.id,
    }
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: providerID,
      modelID: rest.join("/"),
    }
  }

  const TOOLS = [
    BashTool,
    EditTool,
    WebFetchTool,
    GlobTool,
    GrepTool,
    ListTool,
    // LspDiagnosticTool,
    // LspHoverTool,
    PatchTool,
    ReadTool,
    // MultiEditTool,
    WriteTool,
    TodoWriteTool,
    TaskTool,
    AgentTool,
    TodoReadTool,
  ]

  const TOOL_MAPPING: Record<string, Tool.Info[]> = {
    anthropic: TOOLS.filter((t) => t.id !== "patch"),
    openai: TOOLS.map((t) => ({
      ...t,
      parameters: optionalToNullable(t.parameters),
    })),
    azure: TOOLS.map((t) => ({
      ...t,
      parameters: optionalToNullable(t.parameters),
    })),
    google: TOOLS,
  }

  export async function tools(providerID: string) {
    /*
    const cfg = await Config.get()
    if (cfg.tool?.provider?.[providerID])
      return cfg.tool.provider[providerID].map(
        (id) => TOOLS.find((t) => t.id === id)!,
      )
        */
    return TOOL_MAPPING[providerID] ?? TOOLS
  }

  function optionalToNullable(schema: z.ZodTypeAny): z.ZodTypeAny {
    if (schema instanceof z.ZodObject) {
      const shape = schema.shape
      const newShape: Record<string, z.ZodTypeAny> = {}

      for (const [key, value] of Object.entries(shape)) {
        const zodValue = value as z.ZodTypeAny
        if (zodValue instanceof z.ZodOptional) {
          newShape[key] = zodValue.unwrap().nullable()
        } else {
          newShape[key] = optionalToNullable(zodValue)
        }
      }

      return z.object(newShape)
    }

    if (schema instanceof z.ZodArray) {
      return z.array(optionalToNullable(schema.element))
    }

    if (schema instanceof z.ZodUnion) {
      return z.union(
        schema.options.map((option: z.ZodTypeAny) =>
          optionalToNullable(option),
        ) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
      )
    }

    return schema
  }

  // Re-export errors from the separate errors module to maintain backward compatibility
  export const ModelNotFoundError = ProviderErrors.ModelNotFoundError
  export const InitError = ProviderErrors.InitError
  export const AuthError = ProviderErrors.AuthError
}
