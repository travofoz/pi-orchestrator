# 04_button_interaction_matrix

## Objective
Implement GPIO9 OneButton pattern with single-click, double-click, long-press, and super-long-press detection

## Done When
Single click toggles STA/SoftAP mode. Double click dispatches powerdown event and enters Phase 5. Long press (10s) reformats NVS and reboots. All transitions debounced below platform noise floor.
