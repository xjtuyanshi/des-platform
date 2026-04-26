# Process Flow Target Semantics

This document defines intended runtime semantics for the AI-native DES process-flow layer. It describes target behavior, not legacy behavior.

## Admission

All block-to-block movement goes through an admission check before an entity is scheduled to enter the receiver block.

`AdmissionResult` has three outcomes:

- `accepted`: the receiver can accept the entity now.
- `blocked`: the sender keeps the entity at its output until the receiver can accept it.
- `rejected`: the model intentionally rejects or diverts the entity.

Blocked outputs are indexed by receiver block. A receiver must wake blocked senders when it releases capacity. Queue blocks also register themselves by the downstream receiver they are waiting for, so downstream capacity release can drain the upstream queue.

Same-time events use pending admissions. If an entity is accepted into a constrained receiver but has not executed its enter event yet, that pending entry still consumes admission capacity.

## Queue

Queue is a buffer, not a delay.

- P0 discipline is FIFO.
- If downstream can accept, queue wait can be zero.
- If downstream is full, closed, or busy, queue holds the entity.
- Queue `capacity` counts entities physically waiting in the queue, not entities blocked upstream of the queue.
- Queue full uses `blockUpstream` behavior in P0. `reject` and `drop` remain schema-level extension points.

Queue stats track current length, max length, total wait time, completed waits, and average wait time.

## Resources And Hold

Resource queues and signal holds are constrained receivers.

- Service and seize blocks accept immediately if a resource is available.
- If no resource is available, `queueCapacity` limits waiting requests.
- Closed signal holds accept until their hold queue capacity is reached.
- Signal release wakes held entities and then wakes upstream blocked senders.

Capacity exhaustion is a blocking condition, not a model crash. Unknown ids and invalid model references remain errors.

## Storage

Storage is a finite-capacity material location.

- Store waits when storage is full.
- Retrieve waits when no matching item is available.
- Store waits are woken by successful retrieve operations.
- Retrieve waits are woken by successful store operations.
- P0 retrieval policies are `exactItem` and `anyMatchingSku`; `fifo` and `nearest` are reserved for broader warehouse policies.

## Conveyor

Conveyor is a token/slot capacity model.

- Entering a conveyor occupies one slot.
- Travel time is `lengthM / speedMps`.
- Exiting a conveyor releases the slot and wakes waiting entities.
- The process-flow conveyor model does not track continuous item positions.

## Material Handling Transport

`moveByTransporter` remains a Process Flow facade, but route planning and reservation belong to Material Handling.

Material Handling returns a `TransportTaskPlan` containing empty route, load, loaded route, unload, reservations, and completion time. Process Flow schedules the DES completion event from that plan.

Path-guided traffic uses path and node reservations. Nodes have capacity and a non-zero reservation duration by default; the route planner reserves the next node before entering the current path, so a vehicle does not wait at the tail of a path for a blocked intersection.

Intersection nodes are non-waitable by default. If the next path segment is not available, the route planner delays entry into the intersection rather than scheduling a vehicle to queue inside it. Station, dock, charger, parking, storage, and ordinary point nodes are waitable unless `waitAllowed` is explicitly set to `false`.

## Diagnostics

Bad business semantics should surface through diagnostics and repair candidates when possible. Runtime exceptions are reserved for true model errors such as missing block ids, unknown resource pools, unknown storage systems, and unreachable material handling routes.
