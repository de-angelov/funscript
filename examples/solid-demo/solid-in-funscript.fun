import { createSignal, createMemo, createComputed, createRoot } from "solid-js/dist/dev.cjs"

export main = () ->
  console.log("Starting SolidJS in FunScript test...")
  createRoot((dispose) ->
    countSig = createSignal(10)
    count = countSig[0]
    setCount = countSig[1]

    doubled = createMemo(() -> count() * 2)

    createComputed(() ->
      console.log("Solid createComputed triggered -> count: {count()}, doubled: {doubled()}")
    )

    console.log("Updating signal to 20:")
    setCount(20)
    console.log("Updating signal to 50:")
    setCount(50)
    dispose()
  )
