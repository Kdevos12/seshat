theorem Harness.add_zero' (n : Nat) : n + 0 = n := Nat.add_zero n


#print axioms Harness.add_zero'
set_option pp.all true in
set_option pp.maxSteps 100000000 in
#check @Harness.add_zero'
