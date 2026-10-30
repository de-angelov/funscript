# Example: Order Fulfillment & Delivery Pipeline
# Demonstrates a complete real-world functional workflow in FunScript:
# 1. Algebraic data types and pattern matching (ts-pattern)
# 2. Immutable nested domain state updates and draft recipes (Mutative)
# 3. Typed effects, concurrent batch checks, retry policies, background fibers, and layer provision (Effect)

import { Array, Console, Effect, Fiber, Layer, Number, Schedule, pipe } from "effect"

# --- Domain Data Model (Schemas) ---

export schema DeliveryTier =
  | Standard
  | Express
  | Overnight

export schema PaymentMethod =
  | CreditCard(last4: String, brand: String)
  | DigitalWallet(provider: String, email: String)
  | Crypto(network: String, txHash: String)

export schema OrderResult =
  | Success(orderId: String, txId: String, trackingNumber: String)
  | Failed(orderId: String, reason: String)

export schema ShippingDetails = {
  recipient: String
  address: String
  carrier: String
  trackingNumber: String
  estimatedDays: Number
}

export schema Order = {
  id: String
  customer: String
  itemCount: Number
  total: Number
  status: String
  shipping: ShippingDetails
}

# --- Pure Domain Logic (ts-pattern & Mutative) ---

# Exhaustive pattern matching on DeliveryTier
export calculateShippingFee = (tier: DeliveryTier) ->
  match tier
    | Standard -> 5
    | Express -> 15
    | Overnight -> 30

# Exhaustive pattern matching on PaymentMethod with field deconstruction
export formatPaymentMethod = (method: PaymentMethod) ->
  match method
    | CreditCard(last4, brand) -> "{brand} ending in {last4}"
    | DigitalWallet(provider, email) -> "{provider} wallet ({email})"
    | Crypto(network, txHash) -> "Crypto on {network} ({txHash})"

# Pattern matching on OrderResult
export describeResult = (res: OrderResult) ->
  match res
    | Success(id, tx, tracking) -> "SUCCESS: Order {id} settled (Tx: {tx}) and dispatched with tracking #{tracking}"
    | Failed(id, reason) -> "FAILED: Order {id} processing stopped: {reason}"

# Mutative deep record updates (dot-path syntax)
export updateShipping = (order: Order, carrier: String, trackingNumber: String, estimatedDays: Number) ->
  {
    ...order
    shipping.carrier: carrier
    shipping.trackingNumber: trackingNumber
    shipping.estimatedDays: estimatedDays
    status: "Shipped"
  }

# Pure discount calculation using pipe
export applyDiscount = (order: Order, discount: Number) ->
  {
    ...order
    total: order.total - discount
  }

# Mutative array draft recipe
export appendAuditEntry = (logs: Array<String>, entry: String) ->
  logs
  |> mut (draft) ->
    draft.push(entry)
    draft

# --- Effect Services & Dependencies ---

export service InventoryService
  checkAvailability: (sku: String) -> Effect<Boolean>
  reserveStock: (sku: String, qty: Number) -> Effect<Boolean>

export service PaymentGateway
  charge: (orderId: String, amount: Number, method: PaymentMethod) -> Effect<String>

export service NotificationService
  sendConfirmation: (customer: String, message: String) -> Effect<Void>

# --- Live Layer Implementations ---

mut paymentCallCount: Array<Number> = []

export InventoryServiceLive =
  Layer.succeed(InventoryService, {
    checkAvailability: (sku) ->
      effect
        _ <- Console.log("  [InventoryService] Checking stock for {sku}...")
        true

    reserveStock: (sku, qty) ->
      effect
        _ <- Console.log("  [InventoryService] Reserved {qty} unit(s) of {sku}")
        true
  })

export PaymentGatewayLive =
  Layer.succeed(PaymentGateway, {
    charge: (orderId, amount, method) ->
      effect
        methodDesc = formatPaymentMethod(method)
        _ <- Console.log("  [PaymentGateway] Attempting to charge ${amount} via {methodDesc}")
        _ = paymentCallCount.push(1)
        calls = paymentCallCount.length
        res <- match
          | amount |> greaterThan(50000) ->
              effect
                _ <- Console.log("  [PaymentGateway] Transaction denied: credit limit exceeded")
                _ <- Effect.fail("CreditLimitExceeded")
                ""
          | calls == 1 ->
              effect
                _ <- Console.log("  [PaymentGateway] Transient network glitch on attempt 1! Retrying...")
                _ <- Effect.fail("GatewayTimeout")
                ""
          | _ ->
              effect
                _ <- Console.log("  [PaymentGateway] Payment authorized successfully!")
                "TXN-90210"
        res
  })

export NotificationServiceLive =
  Layer.succeed(NotificationService, {
    sendConfirmation: (customer, message) ->
      Console.log("  [NotificationService] Sent confirmation to {customer}: {message}")
  })

export AppLive =
  InventoryServiceLive
  |> Layer.merge(PaymentGatewayLive)
  |> Layer.merge(NotificationServiceLive)

# Helper for service call wrapped in effect
export checkSku = (sku: String) ->
  effect
    avail <- InventoryService.checkAvailability(sku)
    avail

export executePayment = (orderId: String, amount: Number, method: PaymentMethod) ->
  effect
    tx <- PaymentGateway.charge(orderId, amount, method)
    tx

export notifyCustomer = (customer: String, message: String) ->
  effect
    _ <- NotificationService.sendConfirmation(customer, message)
    true

# --- Workflow Implementation ---

export processOrderWorkflow = (order: Order, method: PaymentMethod, tier: DeliveryTier) ->
  effect
    _ <- Console.log("=== Starting Fulfillment for Order {order.id} ===")
    _ <- Console.log("Customer: {order.customer}, Initial Total: ${order.total}")

    # 1. Concurrency: Run parallel stock availability checks across warehouse locations
    _ <- Console.log("Step 1: Running concurrent inventory checks...")
    checks = [
      checkSku("SKU-LAPTOP-01"),
      checkSku("SKU-DOCK-02")
    ]
    availabilities <- Effect.all(checks, { concurrency: "unbounded" })
    _ <- Console.log("  Stock available across all warehouses: {availabilities.length} checked")

    # 2. Reserve stock items
    _ <- InventoryService.reserveStock("SKU-LAPTOP-01", 1)
    _ <- InventoryService.reserveStock("SKU-DOCK-02", 1)

    # 3. Calculate shipping fee and apply member discount
    fee = calculateShippingFee(tier)
    _ <- Console.log("Step 2: Applied delivery tier fee: ${fee}")
    orderWithFee = { ...order, total: order.total + fee }
    discountedOrder = applyDiscount(orderWithFee, 10)
    _ <- Console.log("  Applied promotional discount: Final total = ${discountedOrder.total}")

    # 4. Process payment with automatic retry on transient failure
    _ <- Console.log("Step 3: Processing payment with retry policy...")
    txId <- executePayment(discountedOrder.id, discountedOrder.total, method) |> Effect.retry(Schedule.recurs(2))

    # 5. Mutative update of shipping record
    _ <- Console.log("Step 4: Dispatching package and updating tracking info...")
    trackingNum = "TRACK-GLO-8849"
    finalOrder = updateShipping(discountedOrder, "GlobalExpress", trackingNum, 2)

    # 6. Concurrency: Fork background notification fiber
    _ <- Console.log("Step 5: Emitting customer notification...")
    notifyFiber <- Effect.fork(notifyCustomer(finalOrder.customer, "Your order {finalOrder.id} is confirmed! Tracking: {trackingNum}"))
    _ <- Fiber.join(notifyFiber)

    # 7. Immutably append audit records
    log0: Array<String> = []
    log1 = appendAuditEntry(log0, "Order initialized")
    log2 = appendAuditEntry(log1, "Inventory reserved")
    log3 = appendAuditEntry(log2, "Payment processed: {txId}")
    log4 = appendAuditEntry(log3, "Dispatched via GlobalExpress")
    _ <- Console.log("  Audit trail: {log4.length} events logged immutably")

    Success(finalOrder.id, txId, trackingNum)

export processOrderSafely = (order: Order, method: PaymentMethod, tier: DeliveryTier) ->
  processOrderWorkflow(order, method, tier)
  |> Effect.catchAll((err) ->
    effect
      _ <- Console.log("  [Workflow Recovery] Caught domain error: {err}")
      Failed(order.id, err)
  )

# --- Initial Demo State & Main Entrypoint ---

export sampleOrder: Order = {
  id: "ORD-9402"
  customer: "Grace Hopper"
  itemCount: 2
  total: 450
  status: "Pending"
  shipping: {
    recipient: "Grace Hopper"
    address: "100 Naval Yard Way, Arlington, VA"
    carrier: "Unassigned"
    trackingNumber: "PENDING"
    estimatedDays: 5
  }
}

export payment: PaymentMethod = CreditCard("4242", "Visa")

export highValueOrder: Order = {
  id: "ORD-9999"
  customer: "Charles Babbage"
  itemCount: 50
  total: 90000
  status: "Pending"
  shipping: {
    recipient: "Charles Babbage"
    address: "1 Dorset Street, London"
    carrier: "Unassigned"
    trackingNumber: "PENDING"
    estimatedDays: 3
  }
}

export digitalPayment: PaymentMethod = DigitalWallet("ApplePay", "babbage@example.com")

export program =
  effect
    # Scenario 1: Standard order with transient retry and successful dispatch
    res1 <- processOrderSafely(sampleOrder, payment, Express)
    summary1 = describeResult(res1)
    _ <- Console.log("=== Scenario 1 Result ===")
    _ <- Console.log(summary1)

    # Scenario 2: High-value order failing credit limit, caught with Effect.catchAll
    res2 <- processOrderSafely(highValueOrder, digitalPayment, Overnight)
    summary2 = describeResult(res2)
    _ <- Console.log("=== Scenario 2 Result ===")
    _ <- Console.log(summary2)
    [res1, res2]

export main =
  program
  |> Effect.provide(AppLive)
