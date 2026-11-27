// Password hashing entirely through Effect services: Kdf (PBKDF2-SHA256),
// SecureRandom for the salt, and effect/encoding for byte/hex conversions.
// NodeCrypto.layer supplies the platform crypto services.
import { Console, Effect, Layer, Option, Result, Schema } from "effect"
import { Digest, Kdf, SecureRandom } from "effect/crypto"
import { NodeCrypto } from "@effect/platform-node"
import { Hex } from "effect/encoding"

export error CryptoFailure(message: String)

export schema HashedPassword = String |> Schema.brand("HashedPassword")

pbkdf2 = Kdf.pbkdf2({ hash: Digest.sha256, iterations: 120000 })

// Raw TypeScript gives us a UTF-8 byte view without Node APIs.
encodeUtf8 = (value: String) => ts { new TextEncoder().encode(value) }

decodeHex = (value: String) =>
  Hex.decode(value)
  |> getSuccess
  |> getOrElse(() => Uint8Array.of())

export service PasswordHasher
  hash: (password: String) => Effect<HashedPassword, CryptoFailure>
  verify: (password: String, stored: HashedPassword) => Effect<Boolean, CryptoFailure>

PasswordHasherLive = Layer.effect(PasswordHasher, effect {
  kdf <- Kdf.Kdf
  random <- SecureRandom.SecureRandom
  => {
    hash: (password: String) =>
      effect {
        salt <- random.randomBytes(16)
        secret = encodeUtf8(password)
        derived <- kdf.derive(pbkdf2, secret, { salt, length: 32 })
        => HashedPasswordFromUnknown("{Hex.encode(salt)}:{Hex.encode(derived)}")
      }
      |> mapError(() => CryptoFailure({ message: "Could not hash the password." }))
    verify: (password: String, stored: HashedPassword) =>
      effect {
        parts = stored |> String.split(":")
        salt =
          parts[0]
          |> getOrElse(() => "")
          |> decodeHex
        expected = parts[1] |> getOrElse(() => "")
        secret = encodeUtf8(password)
        derived <- kdf.derive(pbkdf2, secret, { salt, length: 32 })
        => (derived |> Hex.encode) #= expected
      }
      |> mapError(() => CryptoFailure({ message: "Could not verify the password." }))
  }
})

export main =
  effect {
    stored <- PasswordHasher.hash("correct horse battery staple")
    good <- PasswordHasher.verify("correct horse battery staple", stored)
    bad <- PasswordHasher.verify("wrong password", stored)
    _ <- Console.log("stored: {stored}")
    _ <- Console.log("valid password: {good}")
    _ <- Console.log("wrong password: {bad}")
    => good
  }
  |> provide(Layer.provide(PasswordHasherLive, NodeCrypto.layer))
