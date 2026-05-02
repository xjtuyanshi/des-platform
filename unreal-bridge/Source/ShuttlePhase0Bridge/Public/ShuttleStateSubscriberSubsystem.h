#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "ShuttleVisualStateTypes.h"
#include "ShuttleStateSubscriberSubsystem.generated.h"

class IWebSocket;

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnShuttleVehicleState, const FShuttleVisualVehicleState&, VehicleState);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnShuttleBridgeStatus, bool, bConnected, const FString&, Detail);

UCLASS()
class SHUTTLEPHASE0BRIDGE_API UShuttleStateSubscriberSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    virtual void Deinitialize() override;

    UFUNCTION(BlueprintCallable, Category = "Shuttle")
    void Connect(const FString& WebSocketUrl = TEXT("ws://localhost:8791/shuttle-ws"));

    UFUNCTION(BlueprintCallable, Category = "Shuttle")
    void Disconnect();

    UPROPERTY(BlueprintAssignable)
    FOnShuttleVehicleState OnVehicleState;

    UPROPERTY(BlueprintAssignable)
    FOnShuttleBridgeStatus OnBridgeStatus;

private:
    void HandleMessage(const FString& Message);
    FShuttleVisualVehicleState ParseVehicleState(const TSharedPtr<FJsonObject>& Object) const;
    EShuttleVisualOperationalState ParseState(const FString& Value) const;

    TSharedPtr<IWebSocket> Socket;
};
