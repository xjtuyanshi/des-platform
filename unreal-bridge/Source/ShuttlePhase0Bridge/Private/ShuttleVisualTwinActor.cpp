#include "ShuttleVisualTwinActor.h"

AShuttleVisualTwinActor::AShuttleVisualTwinActor()
{
    PrimaryActorTick.bCanEverTick = true;
    Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
    SetRootComponent(Root);
}

void AShuttleVisualTwinActor::BeginPlay()
{
    Super::BeginPlay();
    TargetPosition = GetActorLocation();
    TargetRotation = GetActorRotation();
}

void AShuttleVisualTwinActor::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);

    const float Alpha = FMath::Clamp(DeltaSeconds * InterpolationSpeed, 0.0f, 1.0f);
    SetActorLocation(FMath::Lerp(GetActorLocation(), TargetPosition, Alpha));
    SetActorRotation(FMath::RInterpTo(GetActorRotation(), TargetRotation, DeltaSeconds, InterpolationSpeed));
}

void AShuttleVisualTwinActor::ApplyAuthoritativeState(const FShuttleVisualVehicleState& NextState)
{
    CurrentState = NextState;
    VehicleId = NextState.Id;

    // SimCore uses meters with Z as floor-depth. Unreal uses centimeters with Z as vertical.
    TargetPosition = FVector(NextState.Position.X * 100.0f, NextState.Position.Z * 100.0f, NextState.Position.Y * 100.0f);
    TargetRotation = FRotator(0.0f, FMath::RadiansToDegrees(NextState.YawRadians), 0.0f);
}
