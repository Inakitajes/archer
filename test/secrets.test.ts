import { afterEach, describe, expect, test, mock } from "bun:test"

import { keychainAvailable } from "../src/secrets"

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")
const originalSpawn = Bun.spawn

afterEach(() => {
  if (originalPlatformDescriptor) Object.defineProperty(process, "platform", originalPlatformDescriptor)
  Bun.spawn = originalSpawn
})

describe("keychainAvailable", () => {
  test("returns true on darwin", () => {
    const result = keychainAvailable()
    expect(typeof result).toBe("boolean")
  })

  test("returns false on non-darwin platforms", () => {
    const original = process.platform
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    try {
      const result = keychainAvailable()
      expect(result).toBe(false)
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true })
    }
  })

  test("returns false on windows", () => {
    const original = process.platform
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      const result = keychainAvailable()
      expect(result).toBe(false)
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true })
    }
  })
})

describe("keychain operations (non-darwin paths)", () => {
  test("storeKeychainSecret returns false on non-darwin", async () => {
    const original = process.platform
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    try {
      const { storeKeychainSecret } = await import("../src/secrets")
      const result = await storeKeychainSecret("test-account")
      expect(result).toBe(false)
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true })
    }
  })

  test("readKeychainSecret returns undefined on non-darwin", async () => {
    const original = process.platform
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    try {
      const { readKeychainSecret } = await import("../src/secrets")
      const result = await readKeychainSecret("test-account")
      expect(result).toBeUndefined()
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true })
    }
  })

  test("deleteKeychainSecret returns false on non-darwin", async () => {
    const original = process.platform
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    try {
      const { deleteKeychainSecret } = await import("../src/secrets")
      const result = await deleteKeychainSecret("test-account")
      expect(result).toBe(false)
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true })
    }
  })
})

describe("keychain operations on darwin (mocked Bun.spawn)", () => {
  function makeReadableStream(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    })
  }

  function mockSpawnSuccess(stdoutText = "my-secret\n") {
    return mock((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stdout: makeReadableStream(stdoutText),
    }))
  }

  function mockSpawnFailure() {
    return mock((_cmd: string[]) => ({
      exited: Promise.resolve(1),
      stdout: makeReadableStream(""),
    }))
  }

  function mockSpawnCatch() {
    return mock((_cmd: string[]) => {
      throw new Error("ENOENT")
    })
  }

  async function withDarwin<T>(fn: () => Promise<T>): Promise<T> {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
    try {
      return await fn()
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
    }
  }

  test("storeKeychainSecret returns true on success", async () => {
    await withDarwin(async () => {
      const { storeKeychainSecret } = await import("../src/secrets")
      const spawnMock = mockSpawnSuccess()
      const originalSpawn = Bun.spawn
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn
      try {
        const result = await storeKeychainSecret("test-provider")
        expect(result).toBe(true)
        expect(spawnMock).toHaveBeenCalledTimes(1)
        const args = spawnMock.mock.calls[0]![0] as string[]
        expect(args[0]).toBe("security")
        expect(args[1]).toBe("add-generic-password")
        expect(args).toContain("-s")
        expect(args).toContain("convoy")
        expect(args).toContain("-a")
        expect(args).toContain("test-provider")
      } finally {
        Bun.spawn = originalSpawn
      }
    })
  })

  test("storeKeychainSecret returns false on failure", async () => {
    await withDarwin(async () => {
      const { storeKeychainSecret } = await import("../src/secrets")
      const spawnMock = mockSpawnFailure()
      const originalSpawn = Bun.spawn
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn
      try {
        const result = await storeKeychainSecret("test-provider")
        expect(result).toBe(false)
      } finally {
        Bun.spawn = originalSpawn
      }
    })
  })

  test("readKeychainSecret returns secret on success", async () => {
    await withDarwin(async () => {
      const { readKeychainSecret } = await import("../src/secrets")
      const spawnMock = mockSpawnSuccess("api-key-123\n")
      const originalSpawn = Bun.spawn
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn
      try {
        const result = await readKeychainSecret("test-provider")
        expect(result).toBe("api-key-123")
        const args = spawnMock.mock.calls[0]![0] as string[]
        expect(args[0]).toBe("security")
        expect(args[1]).toBe("find-generic-password")
      } finally {
        Bun.spawn = originalSpawn
      }
    })
  })

  test("readKeychainSecret returns undefined when process exits non-zero", async () => {
    await withDarwin(async () => {
      const { readKeychainSecret } = await import("../src/secrets")
      const spawnMock = mockSpawnFailure()
      const originalSpawn = Bun.spawn
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn
      try {
        const result = await readKeychainSecret("test-provider")
        expect(result).toBeUndefined()
      } finally {
        Bun.spawn = originalSpawn
      }
    })
  })

  test("readKeychainSecret returns undefined on spawn exception", async () => {
    await withDarwin(async () => {
      const { readKeychainSecret } = await import("../src/secrets")
      const spawnMock = mockSpawnCatch()
      const originalSpawn = Bun.spawn
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn
      try {
        const result = await readKeychainSecret("test-provider")
        expect(result).toBeUndefined()
      } finally {
        Bun.spawn = originalSpawn
      }
    })
  })

  test("readKeychainSecret returns undefined for empty secret", async () => {
    await withDarwin(async () => {
      const { readKeychainSecret } = await import("../src/secrets")
      const spawnMock = mockSpawnSuccess("  \n")
      const originalSpawn = Bun.spawn
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn
      try {
        const result = await readKeychainSecret("test-provider")
        expect(result).toBeUndefined()
      } finally {
        Bun.spawn = originalSpawn
      }
    })
  })

  test("readKeychainSecret handles secrets with special characters", async () => {
    await withDarwin(async () => {
      const { readKeychainSecret } = await import("../src/secrets")
      const secret = "pass!@#$%^&*()_+-=[]{}|;':\",./<>?`~\n"
      const spawnMock = mockSpawnSuccess(secret)
      const originalSpawn = Bun.spawn
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn
      try {
        const result = await readKeychainSecret("test-provider")
        expect(result).toBe(secret.trim())
      } finally {
        Bun.spawn = originalSpawn
      }
    })
  })

  test("readKeychainSecret handles secret with newlines and spaces", async () => {
    await withDarwin(async () => {
      const { readKeychainSecret } = await import("../src/secrets")
      const spawnMock = mockSpawnSuccess("my-api-key-123\n")
      const originalSpawn = Bun.spawn
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn
      try {
        const result = await readKeychainSecret("test-provider")
        expect(result).toBe("my-api-key-123")
      } finally {
        Bun.spawn = originalSpawn
      }
    })
  })

  test("deleteKeychainSecret returns true on success", async () => {
    await withDarwin(async () => {
      const { deleteKeychainSecret } = await import("../src/secrets")
      const spawnMock = mockSpawnSuccess()
      const originalSpawn = Bun.spawn
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn
      try {
        const result = await deleteKeychainSecret("test-provider")
        expect(result).toBe(true)
        const args = spawnMock.mock.calls[0]![0] as string[]
        expect(args[0]).toBe("security")
        expect(args[1]).toBe("delete-generic-password")
      } finally {
        Bun.spawn = originalSpawn
      }
    })
  })

  test("deleteKeychainSecret returns false on failure", async () => {
    await withDarwin(async () => {
      const { deleteKeychainSecret } = await import("../src/secrets")
      const spawnMock = mockSpawnFailure()
      const originalSpawn = Bun.spawn
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn
      try {
        const result = await deleteKeychainSecret("test-provider")
        expect(result).toBe(false)
      } finally {
        Bun.spawn = originalSpawn
      }
    })
  })

  test("service constant is used in spawn arguments", async () => {
    await withDarwin(async () => {
      const { storeKeychainSecret } = await import("../src/secrets")
      const spawnMock = mockSpawnSuccess()
      const originalSpawn = Bun.spawn
      Bun.spawn = spawnMock as unknown as typeof Bun.spawn
      try {
        await storeKeychainSecret("test-provider")
        const args = spawnMock.mock.calls[0]![0] as string[]
        expect(args).toContain("-s")
        const sIndex = args.indexOf("-s")
        expect(args[sIndex + 1]).toBe("convoy")
      } finally {
        Bun.spawn = originalSpawn
      }
    })
  })
})
