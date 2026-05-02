#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ShuttleVisualStateTypes.h"
#include "ShuttleVisualTwinActor.generated.h"

UCLASS()
class SHUTTLEPHASE0BRIDGE_API AShuttleVisualTwinActor : public AActor
{
    GENERATED_BODY()

public:
    AShuttleVisualTwinActor();

    virtual void Tick(float DeltaSeconds) override;

    UFUNCTION(BlueprintCallable)
    void ApplyAuthoritativeState(const FShuttleVisualVehicleState& NextState);

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shuttle")
    FString VehicleId;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shuttle")
    float InterpolationSpeed = 8.0f;

protected:
    virtual void BeginPlay() override;

private:
    UPROPERTY()
    USceneComponent* Root;

    FShuttleVisualVehicleState CurrentState;
    FVector TargetPosition = FVector::ZeroVector;
    FRotator TargetRotation = FRotator::ZeroRotator;
};
