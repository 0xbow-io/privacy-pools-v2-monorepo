# Project Guidelines

## Solidity Code Style

### NatSpec Comments
Use single-line NatSpec comments with `///` only. Do not use multi-line `/** */` style.

Tags must follow this order (per [Solidity NatSpec](https://docs.soliditylang.org/en/latest/natspec-format.html)):
1. `@title`
2. `@author`
3. `@notice`
4. `@dev`
5. `@param`
6. `@return`
7. `@inheritdoc`
8. `@custom:...`

```solidity
// Good
/// @notice This function does something
/// @dev Extra implementation details
/// @param _value The input value
/// @return _result The output value
function doSomething(uint256 _value) external returns (uint256 _result);

// Bad
/**
 * @notice This function does something
 * @param _value The input value
 * @return result_ The output value
 */
function doSomething(uint256 _value) external returns (uint256 result_);
```

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Constants | `SCREAMING_SNAKE_CASE` | `uint256 public constant MAX_SUPPLY = 1000;` |
| Immutables | `SCREAMING_SNAKE_CASE` | `address public immutable FACTORY;` |
| Public state variables | `camelCase` | `uint256 public totalSupply;` |
| Internal/private state variables | `_camelCase` | `uint256 internal _counter;` |
| Internal/private functions | `_camelCase` | `function _validate() internal` |
| External/public functions | `camelCase` | `function deposit() external` |
| Function parameters | `_camelCase` | `function transfer(address _to, uint256 _amount)` |
| Local variables | `_camelCase` | `uint256 _balance = getBalance();` |
| Return values | `_camelCase` | `returns (uint256 _balance)` |
| ERC-7201 storage pointers | `$` | `RootBufferStorage storage $ = _getRootBufferStorage();` |

### Error Naming

Errors must be prefixed with the contract name followed by an underscore:

```solidity
// Good
error Entrypoint_NativeTransferFailed();
error Keystore_AuthPolicyAlreadySet();
error ASPRegistry_EmptyASPRoot();

// Bad
error NativeTransferFailed();
error AuthPolicyAlreadySet();
```

### Error Handling

Use `require` with custom errors instead of if-revert:

```solidity
// Good
require(_amount != 0, Entrypoint_InvalidAmount());
require(ACCESS_ROUTER.hasRole(_role, msg.sender), Permissioned_NotAuthorized());

// Bad
if (_amount == 0) revert Entrypoint_InvalidAmount();
if (!ACCESS_ROUTER.hasRole(_role, msg.sender)) revert Permissioned_NotAuthorized();
```

### Structs
All structs must be defined in interfaces, not in contracts.

### Interface Design
- Public state variables should have their getters declared in the interface
- Operational methods (e.g. `initialize`) should not be part of the interface

### Section Headers
Use section headers to organize code into logical sections. Note: imports do not need a header.

```solidity
/*///////////////////////////////////////////////////////////////
                            ERRORS
///////////////////////////////////////////////////////////////*/

error Example_InvalidAmount();

/*///////////////////////////////////////////////////////////////
                            EVENTS
///////////////////////////////////////////////////////////////*/

event Deposited(address indexed _user, uint256 _amount);

/*///////////////////////////////////////////////////////////////
                          STATE VARIABLES
///////////////////////////////////////////////////////////////*/

uint256 public totalDeposits;

/*///////////////////////////////////////////////////////////////
                            MODIFIERS
///////////////////////////////////////////////////////////////*/

modifier onlyOwner() {
    // ...
}

/*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
///////////////////////////////////////////////////////////////*/

constructor() {}

/*///////////////////////////////////////////////////////////////
                        EXTERNAL FUNCTIONS
///////////////////////////////////////////////////////////////*/

function deposit() external {}

/*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
///////////////////////////////////////////////////////////////*/

function _validate() internal {}
```

## Testing

### Bulloak & BTT (Branching Tree Technique)

We use [bulloak](https://github.com/alexfertel/bulloak) for test scaffolding with BTT conventions.

#### Commands

```bash
# Check that tests match the tree structure
bulloak check test/unit/Contract.tree
```

Always run `bulloak check` after modifying `.tree` files to ensure tests are in sync. Avoid using `--fix` as it tends to break existing code.

### Mutation Testing

Run [slither-mutate](https://github.com/crytic/slither/wiki/Mutation-Testing) to verify test quality:

```bash
# Run mutation testing on a specific contract
slither-mutate . --test-cmd "forge test --match-contract UnitContractName" --contract-names "ContractName" --timeout 120 -v
```

#### Tree File Syntax

Each test file has a corresponding `.tree` file that defines test structure:

- `Given` = precondition/state setup before the action
- `When` = the action itself
- `It` = expected outcome

```
ContractName::FunctionName
├── Given some precondition
│   └── It should do something
└── Given another precondition
    ├── When some action happens
    │   └── It should behave this way
    └── When different action happens
        └── It should behave differently
```

#### Modifiers for Preconditions

Use modifiers for reusable `Given` preconditions:

```solidity
// import { SOME_ROLE } from 'utils/RolesConstants.sol';
modifier givenCallerHasROLE() {
    _mockHasRole(SOME_ROLE, caller, true);
    _;
}
```

### Foundry Testing Conventions

#### Mocking

Pair `vm.mockCall` with `vm.expectCall` to verify interactions:

```solidity
vm.mockCall(
    target,
    abi.encodeWithSelector(IContract.method.selector, arg1),
    abi.encode(returnValue)
);
vm.expectCall(target, abi.encodeWithSelector(IContract.method.selector, arg1));
```

#### Fuzzing

- Use fuzz parameters for values that don't affect test logic
- Use `bound()` to constrain values to valid ranges (transforms input, no discarded runs)
- Use `vm.assume()` sparingly, only for discrete values - never for ranges (discards runs, may hide bugs)
- Prefer helper functions like `assumePayable()`, `assumeNotPrecompile()` for common exclusions

```solidity
function test_Transfer(address _recipient, uint256 _amount) external {
    // Good: helpers for discrete exclusions
    assumePayable(_recipient);
    assumeNotPrecompile(_recipient);

    // Good: bound() for ranges
    _amount = bound(_amount, 1, type(uint128).max);

    // Bad: vm.assume() for ranges - discards most fuzz runs
    // vm.assume(_amount > 0 && _amount < 1000);
    // ...
}
```

#### Events

Use simplified `vm.expectEmit()` syntax:

```solidity
vm.expectEmit();
emit IContract.EventName(arg1, arg2);
```

#### State Setup

Use `stdstore` to set internal contract state directly. Never call the function you're testing to set up preconditions:

```solidity
using stdStorage for StdStorage;

// Good: use stdstore to mock storage state
function _setViewingKey(address _account, bytes32 _viewingKey) internal {
    stdstore.target(address(contract)).sig('viewingKeys(address)').with_key(_account)
        .checked_write(uint256(_viewingKey));
}

// Bad: calling the function you're testing to set up state
vm.prank(_caller);
contract.setViewingKey(_oldViewingKey); // Don't do this in tests for setViewingKey
```

Use `vm.mockCall` for external contract dependencies. The contract under test should be real, but its dependencies should be mocked:

```solidity
// Good: mock external dependency
vm.mockCall(
    address(externalContract),
    abi.encodeCall(IExternal.someMethod, (arg1)),
    abi.encode(returnValue)
);

// Then call the function under test
contract.functionThatCallsExternal();
```
