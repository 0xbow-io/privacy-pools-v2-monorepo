// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';

interface IEntrypoint {
  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Configuration for an asset
  /// @param enabled Whether the asset is enabled for deposits
  /// @param minAmount The minimum amount required for deposits; must be strictly positive when `enabled`.
  /// @param vettingFeeBPS The vetting fee in basis points
  /// @param maxRelayFee The maximum relay fee in nominal token amount
  struct AssetConfig {
    bool enabled;
    uint256 minAmount;
    uint256 vettingFeeBPS;
    uint256 maxRelayFee;
  }

  /// @notice ERC-7201 namespaced storage for Entrypoint
  /// @dev The ASP registry is intentionally not stored here; it is read on-demand from `poolVault.aspRegistry()`
  /// @param poolVault The pool vault contract
  /// @param assetConfigs Mapping of asset addresses to their configurations
  /// @custom:storage-location erc7201:privacypools.storage.Entrypoint
  struct EntrypointStorage {
    IPoolVault poolVault;
    mapping(address asset => AssetConfig config) assetConfigs;
  }

  /*///////////////////////////////////////////////////////////////
                              EVENTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a deposit is made through the entrypoint
  /// @param _asset The deposited asset address
  /// @param _depositor The address that made the deposit
  /// @param _value The deposited amount (without fees)
  /// @param _fee The vetting fee charged
  event Deposited(address indexed _asset, address indexed _depositor, uint256 _value, uint256 _fee);

  /// @notice Emitted when assets are swept from the contract
  /// @param _asset The address of the swept asset (NATIVE_ASSET for ETH)
  /// @param _recipient The address that received the swept assets
  /// @param _amount The amount of assets swept
  event Swept(address indexed _asset, address indexed _recipient, uint256 _amount);

  /// @notice Emitted when an asset configuration is set
  /// @param _asset The address of the asset
  /// @param _config The new configuration for the asset
  event AssetConfigurationSet(address indexed _asset, AssetConfig _config);

  /// @notice Emitted when the pool vault reference is updated
  /// @param _previous The previous pool vault address
  /// @param _current The new pool vault address
  event PoolVaultSet(address indexed _previous, address indexed _current);

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown when attempting to deposit an unsupported asset
  error Entrypoint_AssetNotEnabled();

  /// @notice Thrown when the deposit amount is below the minimum
  error Entrypoint_BelowMinAmount();

  /// @notice Thrown when the ETH amount does not match the expected amount
  error Entrypoint_InvalidETHAmount();

  /// @notice Thrown when an ERC-20 deposit is sent with non-zero `msg.value`
  error Entrypoint_UnexpectedETHAmount();

  /// @notice Thrown when a fee in basis points is greater than or equal to 10000 (100%)
  error Entrypoint_InvalidFeeBPS();

  /// @notice Thrown when an enabled asset configuration sets `minAmount` to zero, which would allow zero-value deposits
  error Entrypoint_InvalidMinAmount();

  /*///////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Initializes the Entrypoint contract
  /// @param _poolVault The pool vault contract
  function initialize(IPoolVault _poolVault) external;

  /// @notice Deposits funds and optionally registers a label with the ASP
  /// @dev Does not enforce delivery of note secrets to the output note's owner. If the owner is not the caller (e.g. cold
  /// start), failed off-chain delivery can lock funds: the owner cannot spend without those secrets, and only the owner
  /// may ragequit. See tech design: Key Architectural Concepts §3.4.
  /// @param _proof The deposit proof
  /// @param _noteData Discovery data for the output note, forwarded to the vault and bound to the proof context
  /// @param _aspCiphertext The encrypted label data for ASP registration (pass empty bytes to skip)
  function deposit(
    ProofLibV2.DepositProof calldata _proof,
    IPoolVault.NoteData calldata _noteData,
    bytes calldata _aspCiphertext
  ) external payable;

  /// @notice Sweeps all of a given asset from the contract to a recipient
  /// @dev Only callable by addresses with ENTRYPOINT_MANAGER_ROLE
  /// @param _asset The address of the asset to sweep (use NATIVE_ASSET for ETH)
  /// @param _recipient The address to receive the swept assets
  function sweep(address _asset, address _recipient) external;

  /// @notice Sets the configuration for an asset
  /// @dev Only callable by addresses with ENTRYPOINT_MANAGER_ROLE
  /// @dev Fee-on-transfer, deflationary, and rebasing ERC-20 tokens are incompatible with the vault
  ///      since it assumes `transferFrom(amount)` delivers exactly `amount`, and must not be enabled.
  /// @param _asset The address of the asset to configure
  /// @param _config The configuration for the asset
  function setAssetConfiguration(address _asset, AssetConfig calldata _config) external;

  /// @notice Updates the pool vault reference
  /// @dev Only callable by addresses with UPGRADER_ROLE
  /// @dev Keep in mind the PoolVault has allowances for all enabled assets.
  ///       If we ever replace it, we should also call `setAssetConfiguration(asset,
  ///       {enabled: false})` for every enabled asset so the legacy implementation sets
  ///       its allowances to zero, preventing any future drainings.
  ///       The `UPGRADER_ROLE` operator must disable every enabled asset *before*
  ///       calling this function, since calls after it would edit the
  ///       allowances to the new address
  /// @param _poolVault The new pool vault contract
  function setPoolVault(IPoolVault _poolVault) external;

  /*///////////////////////////////////////////////////////////////
                        EXTERNAL VIEW FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Returns the configuration for an asset
  /// @param _asset The address of the asset
  /// @return _config The asset configuration
  function assets(address _asset) external view returns (AssetConfig memory _config);

  /// @notice Returns the pool vault contract
  /// @return _poolVault The pool vault address
  function poolVault() external view returns (IPoolVault _poolVault);
}
